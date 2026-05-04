import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createTaskEntry,
  loadTasksFile,
  makeFailure,
  type TaskEntry,
  type TaskState,
  type TasksFile,
  writeTasksFileAtomic,
} from "@cattyneo/autokit-core";

import {
  type CliDeps,
  type ExecFile,
  getRetryExitCode,
  getWorkflowExitCode,
  type IssueMetadata,
  parseIssueRange,
  runCli,
  TEMPFAIL_EXIT_CODE,
} from "./index.ts";

const NOW = "2026-05-04T19:50:00+09:00";

describe("cli exit code contract", () => {
  it("prioritizes failed over paused/cleaning and returns tempfail for resumable states", () => {
    assert.equal(getWorkflowExitCode([task({ issue: 1, state: "merged" })]), 0);
    assert.equal(getWorkflowExitCode([task({ issue: 1, state: "queued" })]), TEMPFAIL_EXIT_CODE);
    assert.equal(getWorkflowExitCode([task({ issue: 1, state: "paused" })]), TEMPFAIL_EXIT_CODE);
    assert.equal(getWorkflowExitCode([task({ issue: 1, state: "cleaning" })]), TEMPFAIL_EXIT_CODE);
    assert.equal(
      getWorkflowExitCode([
        task({ issue: 1, state: "paused" }),
        task({ issue: 2, state: "failed" }),
      ]),
      1,
    );
  });

  it("uses retry-specific success when cleanup returns tasks to queued", () => {
    assert.equal(getRetryExitCode([task({ issue: 1, state: "queued" })]), 0);
    assert.equal(getRetryExitCode([task({ issue: 1, state: "paused" })]), TEMPFAIL_EXIT_CODE);
    assert.equal(getRetryExitCode([task({ issue: 1, state: "failed" })]), 1);
    assert.equal(getRetryExitCode([task({ issue: 1, state: "merged" })]), 1);
  });

  it("returns 2 for parser and argument validation errors", async () => {
    const harness = makeCliHarness();

    assert.equal(await runCli(["retry", "bad"], harness.deps), 2);
    assert.match(harness.stderr(), /invalid positive integer/);
  });
});

describe("cli task commands", () => {
  it("parses issue ranges with de-duplication and stable ordering", () => {
    assert.deepEqual(parseIssueRange("12,10-11,10"), [10, 11, 12]);
    assert.equal(parseIssueRange("all"), "all");
    assert.throws(() => parseIssueRange("12-10"), /invalid issue range/);
  });

  it("adds labeled open issues with -y and writes tasks.yaml atomically", async () => {
    const root = makeTempDir();
    const issue: IssueMetadata = {
      number: 9,
      title: "[AK-008] cli doctor list cleanup",
      state: "OPEN",
      labels: ["agent-ready", "AK-008"],
    };
    const harness = makeCliHarness(root, {
      fetchIssue: (number) => (number === 9 ? issue : null),
      confirm: () => false,
    });

    const code = await runCli(["add", "9", "--label", "agent-ready", "-y"], harness.deps);

    assert.equal(code, 0);
    assert.match(harness.stdout(), /targets: 1, additions: 1/);
    const loaded = loadTasksFile(tasksPath(root));
    assert.equal(loaded.tasks[0].issue, 9);
    assert.equal(loaded.tasks[0].cached.title_at_add, issue.title);
    assert.equal(existsSync(`${tasksPath(root)}.tmp`), false);
  });

  it("renders list --json and status without exposing issue body or PR diffs", async () => {
    const root = makeTempDir();
    writeTasks(root, [
      task({ issue: 9, state: "queued" }),
      task({ issue: 10, state: "implementing", runtimePhase: "implement" }),
    ]);
    const listHarness = makeCliHarness(root);

    assert.equal(await runCli(["list", "--json"], listHarness.deps), 0);
    const entries = JSON.parse(listHarness.stdout()) as Array<{ issue: number; state: TaskState }>;
    assert.deepEqual(
      entries.map((entry) => [entry.issue, entry.state]),
      [
        [9, "queued"],
        [10, "implementing"],
      ],
    );

    const statusHarness = makeCliHarness(root);
    assert.equal(await runCli(["status"], statusHarness.deps), 0);
    assert.deepEqual(JSON.parse(statusHarness.stdout()).issue, 10);
  });

  it("rejects resume of retry_cleanup_failed paused tasks with tempfail", async () => {
    const root = makeTempDir();
    writeTasks(root, [
      {
        ...task({ issue: 9, state: "paused" }),
        failure: makeFailure({
          phase: "retry",
          code: "retry_cleanup_failed",
          message: "busy worktree",
          ts: NOW,
        }),
      },
    ]);
    const harness = makeCliHarness(root);

    assert.equal(await runCli(["resume", "9"], harness.deps), TEMPFAIL_EXIT_CODE);
    assert.match(harness.stderr(), /autokit retry/);
  });
});

describe("cli doctor/retry/cleanup gates", () => {
  it("fails doctor when API key env is exported and warns on missing config only", async () => {
    const root = makeTempDir();
    const okExec: ExecFile = () => "ok";
    const passHarness = makeCliHarness(root, { execFile: okExec });

    assert.equal(await runCli(["doctor"], passHarness.deps), 0);
    assert.match(passHarness.stdout(), /WARN\tconfig\t\.autokit\/config\.yaml not found/);

    const failHarness = makeCliHarness(root, {
      env: { ANTHROPIC_API_KEY: "dummy" },
      execFile: okExec,
    });

    assert.equal(await runCli(["doctor"], failHarness.deps), 1);
    assert.match(failHarness.stdout(), /FAIL\tenv unset\tANTHROPIC_API_KEY must not be exported/);
  });

  it("recovers a corrupt queue from tasks.yaml.bak for retry --recover-corruption", async () => {
    const root = makeTempDir();
    writeTasks(root, [task({ issue: 9, state: "paused" })]);
    const backup = readFileSync(tasksPath(root), "utf8");
    writeFileSync(`${tasksPath(root)}.bak`, backup, { mode: 0o600 });
    writeFileSync(tasksPath(root), "version: [", { mode: 0o600 });
    const harness = makeCliHarness(root);

    assert.equal(await runCli(["retry", "--recover-corruption", "9"], harness.deps), 0);
    assert.match(harness.stdout(), /recover-corruption target: #9/);
    assert.equal(loadTasksFile(tasksPath(root)).tasks[0].issue, 9);
  });

  it("verifies merged PR head before cleanup --force-detach can mark a task merged", async () => {
    const root = makeTempDir();
    writeTasks(root, [forceDetachTask({ issue: 9, state: "cleaning" })]);
    const harness = makeCliHarness(root, {
      execFile: () =>
        JSON.stringify({
          state: "MERGED",
          mergedAt: "2026-05-04T10:00:00Z",
          headRefOid: "head-9",
          mergeable: "UNKNOWN",
        }),
      confirm: () => true,
    });

    assert.equal(await runCli(["cleanup", "--force-detach", "9"], harness.deps), 0);
    const loaded = loadTasksFile(tasksPath(root)).tasks[0];
    assert.equal(loaded.state, "merged");
    assert.equal(loaded.cleaning_progress.worktree_remove_attempts, 0);
  });

  it("pauses cleanup --force-detach on OPEN PR or head mismatch instead of forcing merged", async () => {
    const root = makeTempDir();
    writeTasks(root, [forceDetachTask({ issue: 9, state: "cleaning" })]);
    const harness = makeCliHarness(root, {
      execFile: () =>
        JSON.stringify({
          state: "OPEN",
          mergedAt: null,
          headRefOid: "head-9",
          mergeable: "MERGEABLE",
        }),
    });

    assert.equal(await runCli(["cleanup", "--force-detach", "9"], harness.deps), 1);
    const loaded = loadTasksFile(tasksPath(root)).tasks[0];
    assert.equal(loaded.state, "paused");
    assert.equal(loaded.failure?.code, "merge_sha_mismatch");
  });
});

type TaskOptions = {
  issue: number;
  state: TaskState;
  runtimePhase?: TaskEntry["runtime_phase"];
};

function task(options: TaskOptions): TaskEntry {
  return {
    ...createTaskEntry({
      issue: options.issue,
      slug: `ak-${String(options.issue).padStart(3, "0")}`,
      title: `AK-${String(options.issue).padStart(3, "0")}`,
      labels: ["agent-ready"],
      now: NOW,
    }),
    state: options.state,
    runtime_phase: options.runtimePhase ?? null,
    failure:
      options.state === "failed"
        ? makeFailure({ phase: "review", code: "review_max", message: "max", ts: NOW })
        : null,
    timestamps: {
      added_at: NOW,
      started_at: options.state === "queued" ? null : NOW,
      completed_at: options.state === "merged" ? NOW : null,
    },
  };
}

function forceDetachTask(options: { issue: number; state: "cleaning" | "paused" }): TaskEntry {
  return {
    ...task({ issue: options.issue, state: options.state }),
    pr: {
      number: options.issue + 20,
      head_sha: `head-${options.issue}`,
      base_sha: "base",
      created_at: NOW,
    },
    branch: `autokit/issue-${options.issue}`,
    worktree_path: `.autokit/worktrees/issue-${options.issue}`,
    failure:
      options.state === "paused"
        ? makeFailure({
            phase: "cleanup",
            code: "worktree_remove_failed",
            message: "busy",
            ts: NOW,
          })
        : null,
  };
}

function makeCliHarness(
  root = makeTempDir(),
  overrides: Partial<Omit<CliDeps, "cwd" | "stdout" | "stderr">> = {},
): { deps: CliDeps; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    deps: {
      cwd: root,
      env: {},
      now: () => NOW,
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
      execFile: (command, args) => {
        throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
      },
      ...overrides,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function writeTasks(root: string, tasks: TaskEntry[]): void {
  const tasksFile: TasksFile = { version: 1, generated_at: NOW, tasks };
  writeTasksFileAtomic(tasksPath(root), tasksFile);
}

function tasksPath(root: string): string {
  return join(root, ".autokit", "tasks.yaml");
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autokit-cli-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}
