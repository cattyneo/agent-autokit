import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type AgentRunInput,
  createTaskEntry,
  type FailureCode,
  type OperationalAuditKind,
  parseConfig,
  type TaskEntry,
  transitionTask,
} from "../../packages/core/src/index.ts";
import {
  computeFindingId,
  type ImplementFixGitDeps,
  type ReviewFinding,
  runFixWorkflow,
  runReviewSuperviseWorkflow,
  type WorkflowRunner,
} from "../../packages/workflows/src/index.ts";

type AuditEvent = { kind: OperationalAuditKind | FailureCode; fields: Record<string, unknown> };

describe("review-fix loop E2E evidence", () => {
  it("passes review in one round without entering fix", async () => {
    const audits: AuditEvent[] = [];
    const result = await runReviewSuperviseWorkflow(reviewingTask(), {
      runner: queueRunner([], [completed("claude", { findings: [] })]),
      repoRoot: "/repo",
      worktreeRoot: "/repo/.autokit/worktrees/issue-95",
      auditOperation: (kind, fields) => audits.push({ kind, fields }),
      auditFailure: (input) => recordFailure(audits, input),
    });

    assert.equal(result.task.state, "ci_waiting");
    assert.equal(result.task.runtime_phase, "ci_wait");
    assert.equal(result.task.review_round, 0);
    assert.deepEqual(
      audits.map((event) => event.kind),
      ["phase_started"],
    );
  });

  it("records review-fix audit sequence and fails with review_max on the third accepted round", async () => {
    const audits: AuditEvent[] = [];
    let task = reviewingTask();
    const config = parseConfig({ review: { max_rounds: 2 } });

    let review = await runAcceptedReview(task, audits, config);
    assert.equal(review.task.state, "fixing");
    assert.equal(review.task.review_round, 1);
    task = (await runFix(review.task, audits)).task;
    assert.equal(task.state, "reviewing");

    review = await runAcceptedReview(task, audits, config);
    assert.equal(review.task.state, "fixing");
    assert.equal(review.task.review_round, 2);
    task = (await runFix(review.task, audits)).task;
    assert.equal(task.state, "reviewing");

    review = await runAcceptedReview(task, audits, config);
    assert.equal(review.task.state, "failed");
    assert.equal(review.task.failure?.code, "review_max");
    assert.equal(review.task.review_round, 2);
    assertFailureAudit(audits, "review_max");
    assertAuditSubsequence(audits, [
      "phase_started",
      "review_finding_seen",
      "fix_started",
      "fix_finished",
      "review_started",
    ]);
  });

  it("inherits review_round when resuming a review-fix loop", async () => {
    const audits: AuditEvent[] = [];
    const task = {
      ...reviewingTask(),
      review_round: 1,
    };

    const result = await runAcceptedReview(
      task,
      audits,
      parseConfig({ review: { max_rounds: 2 } }),
    );

    assert.equal(result.task.state, "fixing");
    assert.equal(result.task.review_round, 2);
    assert.equal(result.task.failure, null);
  });

  it("fails with prompt_contract_violation after one self-correction retry", async () => {
    const audits: AuditEvent[] = [];
    const persisted: Array<boolean | null> = [];
    const calls: AgentRunInput[] = [];

    const result = await runReviewSuperviseWorkflow(reviewingTask(), {
      runner: async (input) => {
        calls.push(input);
        throw Object.assign(new Error("bad review payload"), {
          code: "prompt_contract_violation",
        });
      },
      repoRoot: "/repo",
      worktreeRoot: "/repo/.autokit/worktrees/issue-95",
      persistTask: (next) => persisted.push(next.runtime.phase_self_correct_done),
      auditOperation: (kind, fields) => audits.push({ kind, fields }),
      auditFailure: (input) => recordFailure(audits, input),
    });

    assert.equal(result.task.state, "failed");
    assert.equal(result.task.failure?.code, "prompt_contract_violation");
    assertFailureAudit(audits, "prompt_contract_violation");
    assert.equal(persisted.includes(true), true);
    assert.equal(calls.length, 2);
    assert.equal(audits.filter((event) => event.kind === "phase_self_correct").length, 1);
  });

  it("fails with phase_attempt_exceeded before rerunning a cold fix phase", async () => {
    const audits: AuditEvent[] = [];
    const calls: AgentRunInput[] = [];
    const task = fixingTask("review");
    task.runtime.phase_attempt = 2;
    task.git.checkpoints.fix.before_sha = "fix-before";
    task.git.checkpoints.fix.rebase_done = "rebased";

    const result = await runFixWorkflow(task, {
      runner: queueRunner(calls, [
        completed("codex", {
          changed_files: [],
          tests_run: [],
          resolved_accept_ids: [],
          unresolved_accept_ids: [],
          notes: "should not run",
        }),
      ]),
      git: mockGitDeps([], []),
      repoRoot: "/repo",
      worktreeRoot: "/repo/.autokit/worktrees/issue-95",
      auditFailure: (input) => recordFailure(audits, input),
    });

    assert.equal(result.task.state, "failed");
    assert.equal(result.task.failure?.code, "phase_attempt_exceeded");
    assertFailureAudit(audits, "phase_attempt_exceeded");
    assert.equal(calls.length, 0);
  });
});

async function runAcceptedReview(
  task: TaskEntry,
  audits: AuditEvent[],
  config: ReturnType<typeof parseConfig>,
) {
  const finding = reviewFinding();
  const findingId = computeFindingId(finding);
  return runReviewSuperviseWorkflow(task, {
    runner: queueRunner(
      [],
      [
        completed("claude", { findings: [finding] }),
        completed("claude", {
          accept_ids: [findingId],
          reject_ids: [],
          reject_reasons: {},
          fix_prompt: "Fix the finding.",
        }),
      ],
    ),
    repoRoot: "/repo",
    worktreeRoot: "/repo/.autokit/worktrees/issue-95",
    config,
    auditOperation: (kind, fields) => audits.push({ kind, fields }),
    auditFailure: (input) => recordFailure(audits, input),
  });
}

async function runFix(task: TaskEntry, audits: AuditEvent[]) {
  return runFixWorkflow(task, {
    runner: queueRunner(
      [],
      [
        completed("codex", {
          changed_files: ["packages/core/src/index.ts"],
          tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
          resolved_accept_ids: task.review_findings.at(-1)?.accept_ids ?? [],
          unresolved_accept_ids: [],
          notes: "fixed",
        }),
      ],
    ),
    git: mockGitDeps(["fix-before", "rebased", "agent-done"], ["fix-commit"], {
      prHeadSha: "fix-remote-head",
      baseSha: "base-sha",
    }),
    repoRoot: "/repo",
    worktreeRoot: "/repo/.autokit/worktrees/issue-95",
    auditOperation: (kind, fields) => audits.push({ kind, fields }),
  });
}

function assertAuditSubsequence(audits: AuditEvent[], expected: OperationalAuditKind[]): void {
  let index = 0;
  for (const event of audits) {
    if (event.kind !== expected[index]) {
      continue;
    }
    if (event.kind === "phase_started" && event.fields.phase !== "review") {
      continue;
    }
    index += 1;
    if (index === expected.length) {
      return;
    }
  }
  assert.fail(
    `missing audit subsequence ${expected.join(" -> ")} in ${audits
      .map((event) => event.kind)
      .join(" -> ")}`,
  );
}

function recordFailure(
  audits: AuditEvent[],
  input: { failure: { code: FailureCode }; payload?: Record<string, unknown> },
): void {
  audits.push({
    kind: input.failure.code,
    fields: { failure: input.failure, payload: input.payload },
  });
}

function assertFailureAudit(audits: AuditEvent[], code: FailureCode): void {
  const event = audits.find((entry) => entry.kind === code);
  assert.ok(event, `expected failure audit kind: ${code}`);
  const failure = event.fields.failure as { code?: unknown; phase?: unknown; message?: unknown };
  assert.equal(failure.code, code);
  assert.equal(typeof failure.phase, "string");
  assert.equal(typeof failure.message, "string");
}

function reviewingTask(): TaskEntry {
  const task = createTaskEntry({
    issue: 95,
    slug: "review-ci-fix-e2e",
    title: "Review CI fix E2E",
    labels: ["agent-ready"],
    now: "2026-05-05T09:00:00+09:00",
  });
  return {
    ...transitionTask(
      {
        ...task,
        state: "implementing",
        runtime_phase: "implement",
        branch: "autokit/issue-95",
        worktree_path: ".autokit/worktrees/issue-95",
      },
      { type: "pr_ready", headSha: "head-sha", prNumber: 95, baseSha: "base-sha" },
    ),
    branch: "autokit/issue-95",
    worktree_path: ".autokit/worktrees/issue-95",
  };
}

function fixingTask(origin: "review" | "ci"): TaskEntry {
  return {
    ...reviewingTask(),
    state: "fixing",
    runtime_phase: "fix",
    fix: { origin, started_at: "2026-05-05T10:00:00+09:00", ci_failure_log: null },
  };
}

function reviewFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "P1",
    file: "packages/workflows/src/index.ts",
    line: 382,
    title: "Loop evidence missing",
    rationale: "The review-fix loop must emit observable audit evidence.",
    suggested_fix: "Emit an audit event at the loop boundary.",
    ...overrides,
  };
}

function completed(provider: "claude" | "codex", structured: Record<string, unknown>) {
  return {
    status: "completed" as const,
    summary: "ok",
    structured,
    session:
      provider === "claude"
        ? { claudeSessionId: "claude-session" }
        : { codexSessionId: "codex-session" },
  };
}

function queueRunner(
  calls: AgentRunInput[],
  outputs: Awaited<ReturnType<WorkflowRunner>>[],
): WorkflowRunner {
  return async (input) => {
    calls.push(input);
    const output = outputs.shift();
    assert.ok(output, `unexpected runner call for ${input.phase}`);
    return output;
  };
}

function mockGitDeps(
  headShas: string[],
  commitShas: string[],
  options: { prHeadSha?: string; baseSha?: string | null } = {},
): ImplementFixGitDeps {
  return {
    getHeadSha: () => {
      const sha = headShas.shift();
      assert.ok(sha, "expected a queued head sha");
      return sha;
    },
    stageAll: () => undefined,
    commit: () => {
      const sha = commitShas.shift();
      assert.ok(sha, "expected a queued commit sha");
      return sha;
    },
    pushBranch: () => undefined,
    createDraftPr: () => 95,
    getPrHead: () => ({
      headSha: options.prHeadSha ?? "remote-head",
      baseSha: options.baseSha ?? null,
    }),
    markPrReady: () => undefined,
    rebaseOntoBase: () => ({ ok: true }),
  };
}
