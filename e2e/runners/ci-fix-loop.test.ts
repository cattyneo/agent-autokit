import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type AgentRunInput,
  createTaskEntry,
  type OperationalAuditKind,
  parseConfig,
  type TaskEntry,
  transitionTask,
} from "../../packages/core/src/index.ts";
import {
  type CiWaitDeps,
  type CiWaitPrObservation,
  type ImplementFixGitDeps,
  runCiWaitWorkflow,
  runFixWorkflow,
  runReviewSuperviseWorkflow,
  type WorkflowRunner,
} from "../../packages/workflows/src/index.ts";
import type { GhJsonRunner } from "./full-run.ts";

type AuditEvent = { kind: OperationalAuditKind; fields: Record<string, unknown> };

describe("ci-fix loop E2E evidence", () => {
  it("uses fake GitHub CI evidence and fails with ci_failure_max on the third failed observation", async () => {
    let task = ciWaitingTask();
    const gh = fakeGh({
      checkRollups: [
        [{ name: "test-1", status: "COMPLETED", conclusion: "FAILURE" }],
        [{ name: "test-2", status: "COMPLETED", conclusion: "FAILURE" }],
        [{ name: "test-3", status: "COMPLETED", conclusion: "FAILURE" }],
      ],
    });

    for (const round of [1, 2]) {
      const ci = await runCiWaitWorkflow(task, {
        runner: queueRunner([], []),
        github: ciDepsFromGh(gh),
        repoRoot: "/repo",
        worktreeRoot: "/repo/.autokit/worktrees/issue-95",
        config: parseConfig({ ci: { fix_max_rounds: 2 } }),
      });
      assert.equal(ci.task.state, "fixing");
      assert.equal(ci.task.ci_fix_round, round);
      const fixed = await runFix(ci.task, []);
      assert.equal(fixed.task.state, "reviewing");
      const reviewed = await runReviewPass(fixed.task);
      assert.equal(reviewed.task.state, "ci_waiting");
      assert.equal(reviewed.task.ci_fix_round, round);
      task = reviewed.task;
    }

    const result = await runCiWaitWorkflow(task, {
      runner: queueRunner([], []),
      github: ciDepsFromGh(gh),
      repoRoot: "/repo",
      worktreeRoot: "/repo/.autokit/worktrees/issue-95",
      config: parseConfig({ ci: { fix_max_rounds: 2 } }),
    });

    assert.equal(result.task.state, "failed");
    assert.equal(result.task.failure?.code, "ci_failure_max");
    assert.equal(result.task.ci_fix_round, 2);
    assert.equal(result.ciFailureLog, "test-3");
  });

  it("returns CI-origin fixes to review and keeps CI and review rounds independent", async () => {
    const audits: AuditEvent[] = [];
    const gh = fakeGh({
      checkRollups: [[{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }]],
    });
    const ci = await runCiWaitWorkflow(ciWaitingTask(), {
      runner: queueRunner([], []),
      github: ciDepsFromGh(gh),
      repoRoot: "/repo",
      worktreeRoot: "/repo/.autokit/worktrees/issue-95",
    });

    assert.equal(ci.task.state, "fixing");
    assert.equal(ci.task.fix.origin, "ci");
    assert.equal(ci.task.ci_fix_round, 1);
    assert.equal(ci.task.review_round, 0);

    const fixed = await runFix(ci.task, audits);

    assert.equal(fixed.task.state, "reviewing");
    assert.equal(fixed.task.runtime_phase, "review");
    assert.equal(fixed.task.fix.origin, null);
    assert.equal(fixed.task.ci_fix_round, 1);
    assert.equal(fixed.task.review_round, 0);
    assert.deepEqual(
      audits.map((event) => event.kind).filter((kind) => kind !== "phase_started"),
      ["fix_started", "fix_finished", "review_started"],
    );
  });
});

function ciDepsFromGh(gh: GhJsonRunner): CiWaitDeps {
  return {
    getChecks: (prNumber) => {
      const checks = gh(["pr", "view", String(prNumber), "--json", "statusCheckRollup"]);
      assert.equal(checks.ok, true, checks.stderr);
      const rollup = asRecord(checks.stdout).statusCheckRollup;
      assert.ok(Array.isArray(rollup), "statusCheckRollup must be an array");
      if (rollup.length === 0) {
        return { status: "pending" };
      }
      if (rollup.some((check) => asRecord(check).status !== "COMPLETED")) {
        return { status: "pending" };
      }
      const failed = rollup.filter((check) => {
        const conclusion = String(asRecord(check).conclusion ?? "").toUpperCase();
        return conclusion !== "SUCCESS" && conclusion !== "SKIPPED";
      });
      if (failed.length === 0) {
        return { status: "success" };
      }
      return {
        status: "failure",
        failedLog: failed.map((check) => String(asRecord(check).name)).join(", "),
      };
    },
    getPr: (prNumber, _site) => {
      const view = gh([
        "pr",
        "view",
        String(prNumber),
        "--json",
        "headRefOid,mergeable,mergeStateStatus,autoMergeRequest",
      ]);
      assert.equal(view.ok, true, view.stderr);
      const record = asRecord(view.stdout);
      return {
        headSha: record.headRefOid === undefined ? null : String(record.headRefOid),
        mergeable:
          record.mergeStateStatus === "BLOCKED"
            ? "BLOCKED"
            : record.mergeable === "MERGEABLE"
              ? "MERGEABLE"
              : "UNKNOWN",
        autoMergeRequest: record.autoMergeRequest ?? null,
      };
    },
    reserveAutoMerge: () => undefined,
    disableAutoMerge: () => undefined,
    sleep: () => undefined,
  };
}

function fakeGh(options: {
  checkRollups: Array<Array<Record<string, unknown>>>;
  prViews?: CiWaitPrObservation[];
}): GhJsonRunner {
  return (args) => {
    const command = JSON.stringify(args);
    if (command === JSON.stringify(["pr", "view", "95", "--json", "statusCheckRollup"])) {
      const next = options.checkRollups.shift();
      assert.ok(next, "expected queued statusCheckRollup");
      return { ok: true, stdout: { statusCheckRollup: next }, status: 0 };
    }
    if (
      command ===
      JSON.stringify([
        "pr",
        "view",
        "95",
        "--json",
        "headRefOid,mergeable,mergeStateStatus,autoMergeRequest",
      ])
    ) {
      const next = options.prViews?.shift() ?? {
        headSha: "head-sha",
        mergeable: "MERGEABLE" as const,
        autoMergeRequest: null,
      };
      return {
        ok: true,
        stdout: {
          headRefOid: next.headSha,
          mergeable: next.mergeable,
          mergeStateStatus: next.mergeable,
          autoMergeRequest: next.autoMergeRequest,
        },
        status: 0,
      };
    }
    throw new Error(`unexpected gh args: ${command}`);
  };
}

async function runFix(task: TaskEntry, audits: AuditEvent[]) {
  return runFixWorkflow(task, {
    runner: queueRunner(
      [],
      [
        completed("codex", {
          changed_files: ["packages/workflows/src/index.ts"],
          tests_run: [
            {
              command: "bun test e2e/runners/ci-fix-loop.test.ts",
              result: "passed",
              summary: "ok",
            },
          ],
          resolved_accept_ids: [],
          unresolved_accept_ids: [],
          notes: "fixed CI",
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

async function runReviewPass(task: TaskEntry) {
  return runReviewSuperviseWorkflow(task, {
    runner: queueRunner([], [completed("claude", { findings: [] })]),
    repoRoot: "/repo",
    worktreeRoot: "/repo/.autokit/worktrees/issue-95",
  });
}

function ciWaitingTask(): TaskEntry {
  return {
    ...reviewingTask(),
    state: "ci_waiting",
    runtime_phase: "ci_wait",
    pr: {
      number: 95,
      head_sha: "head-sha",
      base_sha: "base-sha",
      created_at: "2026-05-05T10:00:00+09:00",
    },
    review_findings: [{ round: 1, accept_ids: [], reject_ids: [], reject_reasons: {} }],
  };
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

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}
