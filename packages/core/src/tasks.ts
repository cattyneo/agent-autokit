import {
  closeSync,
  copyFileSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { parseDocument, stringify } from "yaml";
import * as z from "zod";

import { type FailureCode, failureCodes } from "./failure-codes.ts";
import type { FailureRecord } from "./logger.ts";

export const taskStates = [
  "queued",
  "planning",
  "planned",
  "implementing",
  "reviewing",
  "fixing",
  "ci_waiting",
  "merging",
  "cleaning",
  "paused",
  "failed",
  "merged",
] as const;

export const taskRuntimePhases = [
  "plan",
  "plan_verify",
  "plan_fix",
  "implement",
  "review",
  "supervise",
  "fix",
  "ci_wait",
  "merge",
] as const;

export type TaskState = (typeof taskStates)[number];
export type TaskRuntimePhase = (typeof taskRuntimePhases)[number];
export type PlanState = "pending" | "verifying" | "verified" | "failed";
export type FixOrigin = "review" | "ci";

export type SimpleCheckpoint = {
  before_sha: string | null;
  after_sha: string | null;
};

export type ImplementCheckpoint = {
  before_sha: string | null;
  agent_done: string | null;
  commit_done: string | null;
  push_done: string | null;
  pr_created: number | null;
  head_sha_persisted: string | null;
  after_sha: string | null;
};

export type FixCheckpoint = ImplementCheckpoint & {
  rebase_done: string | null;
};

export type RetryCleanupProgress = {
  pr_closed: boolean;
  worktree_removed: boolean;
  branch_deleted: boolean;
  fields_cleared: boolean;
};

export type TaskEntry = {
  issue: number;
  slug: string;
  title: string;
  labels: string[];
  state: TaskState;
  runtime_phase: TaskRuntimePhase | null;
  branch: string | null;
  worktree_path: string | null;
  pr: {
    number: number | null;
    head_sha: string | null;
    base_sha: string | null;
    created_at: string | null;
  };
  review_round: number;
  ci_fix_round: number;
  plan: {
    path: string;
    state: PlanState;
    plan_verify_round: number;
    verified_at: string | null;
  };
  git: {
    base_sha: string | null;
    checkpoints: {
      plan: SimpleCheckpoint;
      plan_verify: SimpleCheckpoint;
      plan_fix: SimpleCheckpoint;
      implement: ImplementCheckpoint;
      review: SimpleCheckpoint;
      supervise: SimpleCheckpoint;
      fix: FixCheckpoint;
    };
  };
  provider_sessions: {
    plan: { claude_session_id: string | null };
    plan_verify: { codex_thread_id: string | null };
    plan_fix: { claude_session_id: string | null };
    implement: { codex_thread_id: string | null };
    review: { claude_session_id: string | null };
    supervise: { claude_session_id: string | null };
    fix: { codex_thread_id: string | null };
  };
  fix: {
    origin: FixOrigin | null;
    started_at: string | null;
  };
  retry: {
    cleanup_progress: RetryCleanupProgress | null;
    started_at: string | null;
  };
  runtime: {
    phase_attempt: number;
    last_event_id: string | null;
    interrupted_at: string | null;
    previous_state: TaskState | null;
    resolved_model: Record<
      "plan" | "plan_verify" | "plan_fix" | "implement" | "review" | "supervise" | "fix",
      string | null
    >;
  };
  review_findings: Array<{ round: number; accept_ids: string[]; reject_ids: string[] }>;
  reject_history: Array<Record<string, unknown>>;
  cached: {
    title_at_add: string;
    labels_at_add: string[];
    fetched_at: string;
  };
  timestamps: {
    added_at: string;
    started_at: string | null;
    completed_at: string | null;
  };
  failure: FailureRecord | null;
  failure_history: FailureRecord[];
  failure_history_truncated_count: number;
  owner_pid: number | null;
  owner_pgid: number | null;
  cleaning_progress: {
    grace_period_done: boolean;
    branch_deleted_done: boolean;
    worktree_removed_done: boolean;
    finalized_done: boolean;
    worktree_remove_attempts: number;
  };
};

export type TasksFile = {
  version: 1;
  generated_at: string;
  tasks: TaskEntry[];
};

export type CreateTaskEntryInput = {
  issue: number;
  slug: string;
  title: string;
  labels: string[];
  now: string;
};

export type LoadTasksFileOptions = {
  restoreFromBackup?: boolean;
};

export class TaskFileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskFileParseError";
  }
}

export function createTaskEntry(input: CreateTaskEntryInput): TaskEntry {
  return {
    issue: input.issue,
    slug: input.slug,
    title: input.title,
    labels: [...input.labels],
    state: "queued",
    runtime_phase: null,
    branch: `autokit/issue-${input.issue}`,
    worktree_path: `.autokit/worktrees/issue-${input.issue}`,
    pr: { number: null, head_sha: null, base_sha: null, created_at: null },
    review_round: 0,
    ci_fix_round: 0,
    plan: {
      path: `.autokit/plans/issue-${input.issue}-${input.slug}.md`,
      state: "pending",
      plan_verify_round: 0,
      verified_at: null,
    },
    git: {
      base_sha: null,
      checkpoints: {
        plan: emptySimpleCheckpoint(),
        plan_verify: emptySimpleCheckpoint(),
        plan_fix: emptySimpleCheckpoint(),
        implement: emptyImplementCheckpoint(),
        review: emptySimpleCheckpoint(),
        supervise: emptySimpleCheckpoint(),
        fix: { ...emptyImplementCheckpoint(), rebase_done: null },
      },
    },
    provider_sessions: {
      plan: { claude_session_id: null },
      plan_verify: { codex_thread_id: null },
      plan_fix: { claude_session_id: null },
      implement: { codex_thread_id: null },
      review: { claude_session_id: null },
      supervise: { claude_session_id: null },
      fix: { codex_thread_id: null },
    },
    fix: { origin: null, started_at: null },
    retry: { cleanup_progress: null, started_at: null },
    runtime: {
      phase_attempt: 0,
      last_event_id: null,
      interrupted_at: null,
      previous_state: null,
      resolved_model: {
        plan: null,
        plan_verify: null,
        plan_fix: null,
        implement: null,
        review: null,
        supervise: null,
        fix: null,
      },
    },
    review_findings: [],
    reject_history: [],
    cached: {
      title_at_add: input.title,
      labels_at_add: [...input.labels],
      fetched_at: input.now,
    },
    timestamps: {
      added_at: input.now,
      started_at: null,
      completed_at: null,
    },
    failure: null,
    failure_history: [],
    failure_history_truncated_count: 0,
    owner_pid: null,
    owner_pgid: null,
    cleaning_progress: {
      grace_period_done: false,
      branch_deleted_done: false,
      worktree_removed_done: false,
      finalized_done: false,
      worktree_remove_attempts: 0,
    },
  };
}

export function loadTasksFile(path: string, options: LoadTasksFileOptions = {}): TasksFile {
  try {
    return parseTasksFile(readNonEmptyFile(path));
  } catch (error) {
    if (options.restoreFromBackup !== true) {
      throw normalizeTaskFileError(error);
    }
    const backup = `${path}.bak`;
    const restored = parseTasksFile(readNonEmptyFile(backup));
    writeFileContents(path, stringify(restored));
    return restored;
  }
}

export function writeTasksFileAtomic(path: string, tasksFile: TasksFile): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const backupPath = `${path}.bak`;
    copyFileSync(path, backupPath);
    fsyncExistingFile(backupPath);
    fsyncDirectory(directory);
  }
  const tmpPath = `${path}.tmp`;
  writeFileContents(tmpPath, stringify(tasksFile));
  renameSync(tmpPath, path);
  fsyncDirectory(directory);
}

export function cloneTask<T>(value: T): T {
  return structuredClone(value);
}

export function makeFailure(input: {
  phase: string;
  code: FailureCode;
  message: string;
  ts?: string;
}): FailureRecord {
  return {
    phase: input.phase,
    code: input.code,
    message: input.message,
    ts: input.ts ?? new Date().toISOString(),
  };
}

function emptySimpleCheckpoint(): SimpleCheckpoint {
  return { before_sha: null, after_sha: null };
}

function emptyImplementCheckpoint(): ImplementCheckpoint {
  return {
    before_sha: null,
    agent_done: null,
    commit_done: null,
    push_done: null,
    pr_created: null,
    head_sha_persisted: null,
    after_sha: null,
  };
}

const nullableStringSchema = z.string().nullable();

const failureRecordSchema = z
  .object({
    phase: z.string(),
    code: z.enum(failureCodes),
    message: z.string(),
    ts: z.string(),
  })
  .strict();

const simpleCheckpointSchema = z
  .object({
    before_sha: nullableStringSchema,
    after_sha: nullableStringSchema,
  })
  .strict();

const implementCheckpointSchema = z
  .object({
    before_sha: nullableStringSchema,
    agent_done: nullableStringSchema,
    commit_done: nullableStringSchema,
    push_done: nullableStringSchema,
    pr_created: z.number().int().positive().nullable(),
    head_sha_persisted: nullableStringSchema,
    after_sha: nullableStringSchema,
  })
  .strict();

const fixCheckpointSchema = implementCheckpointSchema
  .extend({
    rebase_done: nullableStringSchema,
  })
  .strict();

const retryCleanupProgressSchema = z
  .object({
    pr_closed: z.boolean(),
    worktree_removed: z.boolean(),
    branch_deleted: z.boolean(),
    fields_cleared: z.boolean(),
  })
  .strict();

const taskEntrySchema = z
  .object({
    issue: z.number().int().positive(),
    slug: z.string(),
    title: z.string(),
    labels: z.array(z.string()),
    state: z.enum(taskStates),
    runtime_phase: z.enum(taskRuntimePhases).nullable(),
    branch: nullableStringSchema,
    worktree_path: nullableStringSchema,
    pr: z
      .object({
        number: z.number().int().positive().nullable(),
        head_sha: nullableStringSchema,
        base_sha: nullableStringSchema,
        created_at: nullableStringSchema,
      })
      .strict(),
    review_round: z.number().int().nonnegative(),
    ci_fix_round: z.number().int().nonnegative(),
    plan: z
      .object({
        path: z.string(),
        state: z.enum(["pending", "verifying", "verified", "failed"]),
        plan_verify_round: z.number().int().nonnegative(),
        verified_at: nullableStringSchema,
      })
      .strict(),
    git: z
      .object({
        base_sha: nullableStringSchema,
        checkpoints: z
          .object({
            plan: simpleCheckpointSchema,
            plan_verify: simpleCheckpointSchema,
            plan_fix: simpleCheckpointSchema,
            implement: implementCheckpointSchema,
            review: simpleCheckpointSchema,
            supervise: simpleCheckpointSchema,
            fix: fixCheckpointSchema,
          })
          .strict(),
      })
      .strict(),
    provider_sessions: z
      .object({
        plan: z.object({ claude_session_id: nullableStringSchema }).strict(),
        plan_verify: z.object({ codex_thread_id: nullableStringSchema }).strict(),
        plan_fix: z.object({ claude_session_id: nullableStringSchema }).strict(),
        implement: z.object({ codex_thread_id: nullableStringSchema }).strict(),
        review: z.object({ claude_session_id: nullableStringSchema }).strict(),
        supervise: z.object({ claude_session_id: nullableStringSchema }).strict(),
        fix: z.object({ codex_thread_id: nullableStringSchema }).strict(),
      })
      .strict(),
    fix: z
      .object({
        origin: z.enum(["review", "ci"]).nullable(),
        started_at: nullableStringSchema,
      })
      .strict(),
    retry: z
      .object({
        cleanup_progress: retryCleanupProgressSchema.nullable(),
        started_at: nullableStringSchema,
      })
      .strict(),
    runtime: z
      .object({
        phase_attempt: z.number().int().nonnegative(),
        last_event_id: nullableStringSchema,
        interrupted_at: nullableStringSchema,
        previous_state: z.enum(taskStates).nullable(),
        resolved_model: z
          .object({
            plan: nullableStringSchema,
            plan_verify: nullableStringSchema,
            plan_fix: nullableStringSchema,
            implement: nullableStringSchema,
            review: nullableStringSchema,
            supervise: nullableStringSchema,
            fix: nullableStringSchema,
          })
          .strict(),
      })
      .strict(),
    review_findings: z.array(
      z
        .object({
          round: z.number().int().positive(),
          accept_ids: z.array(z.string()),
          reject_ids: z.array(z.string()),
        })
        .strict(),
    ),
    reject_history: z.array(z.record(z.string(), z.unknown())),
    cached: z
      .object({
        title_at_add: z.string(),
        labels_at_add: z.array(z.string()),
        fetched_at: z.string(),
      })
      .strict(),
    timestamps: z
      .object({
        added_at: z.string(),
        started_at: nullableStringSchema,
        completed_at: nullableStringSchema,
      })
      .strict(),
    failure: failureRecordSchema.nullable(),
    failure_history: z.array(failureRecordSchema),
    failure_history_truncated_count: z.number().int().nonnegative(),
    owner_pid: z.number().int().positive().nullable(),
    owner_pgid: z.number().int().positive().nullable(),
    cleaning_progress: z
      .object({
        grace_period_done: z.boolean(),
        branch_deleted_done: z.boolean(),
        worktree_removed_done: z.boolean(),
        finalized_done: z.boolean(),
        worktree_remove_attempts: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const tasksFileSchema = z
  .object({
    version: z.literal(1),
    generated_at: z.string(),
    tasks: z.array(taskEntrySchema),
  })
  .strict();

function parseTasksFile(source: string): TasksFile {
  const document = parseDocument(source, { prettyErrors: false, stringKeys: true });
  if (document.errors.length > 0) {
    throw new TaskFileParseError(document.errors.map((error) => error.message).join("; "));
  }
  const parsed = tasksFileSchema.safeParse(document.toJSON());
  if (!parsed.success) {
    throw new TaskFileParseError(parsed.error.message);
  }
  return parsed.data as TasksFile;
}

function readNonEmptyFile(path: string): string {
  const stat = statSync(path);
  if (stat.size === 0) {
    throw new TaskFileParseError("tasks.yaml is 0 bytes");
  }
  return readFileSync(path, "utf8");
}

function writeFileContents(path: string, contents: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncExistingFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function normalizeTaskFileError(error: unknown): TaskFileParseError {
  if (error instanceof TaskFileParseError) {
    return error;
  }
  if (error instanceof Error) {
    return new TaskFileParseError(error.message);
  }
  return new TaskFileParseError(String(error));
}
