import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reconcileTask } from "./reconcile.ts";
import { createTaskEntry, type TaskEntry } from "./tasks.ts";

describe("core reconcile", () => {
  it("normalizes PR-backed active states from current GitHub PR observation", () => {
    const task = prTask("merging", "merge", "abc");

    assert.equal(
      reconcileTask(task, {
        pr: { state: "MERGED", merged: true, headRefOid: "abc", mergeable: "MERGEABLE" },
      }).task.state,
      "cleaning",
    );
    assert.equal(
      reconcileTask(task, {
        pr: { state: "MERGED", merged: true, headRefOid: "def", mergeable: "MERGEABLE" },
      }).task.failure?.code,
      "merge_sha_mismatch",
    );
    assert.equal(
      reconcileTask(task, {
        pr: { state: "CLOSED", merged: false, headRefOid: "abc", mergeable: "UNKNOWN" },
      }).task.failure?.code,
      "other",
    );
    assert.equal(
      reconcileTask(task, {
        pr: { state: "OPEN", merged: false, headRefOid: "def", mergeable: "MERGEABLE" },
      }).task.failure?.code,
      "merge_sha_mismatch",
    );
    assert.equal(
      reconcileTask(task, {
        pr: { state: "OPEN", merged: false, headRefOid: "abc", mergeable: "MERGEABLE" },
      }).action,
      "resume_phase",
    );
  });

  it("handles cleaning residual branch/worktree matrix", () => {
    const task = prTask("cleaning", null, "abc");

    assert.equal(
      reconcileTask(task, { branchExists: false, worktreeExists: false }).task.state,
      "merged",
    );
    assert.equal(
      reconcileTask(task, { branchExists: true, worktreeExists: false, branchDeleteFailed: true })
        .task.failure?.code,
      "branch_delete_failed",
    );
    assert.equal(
      reconcileTask(task, { branchExists: false, worktreeExists: true, worktreeRemoveFailed: true })
        .task.failure?.code,
      "worktree_remove_failed",
    );
    assert.equal(
      reconcileTask(task, { branchExists: true, worktreeExists: true }).action,
      "cleanup_remaining",
    );
  });

  it("applies deterministic restart for active tasks without a PR", () => {
    const plannedVerified = {
      ...baseTask("planned", null),
      plan: { ...baseTask().plan, state: "verified" as const },
    };
    assert.equal(reconcileTask(plannedVerified, {}).task.state, "implementing");

    const plannedPending = baseTask("planned", null);
    assert.equal(reconcileTask(plannedPending, {}).task.failure?.code, "pre_pr_active_orphan");

    const afterSha = {
      ...baseTask("implementing", "implement"),
      git: {
        ...baseTask().git,
        checkpoints: {
          ...baseTask().git.checkpoints,
          implement: { ...baseTask().git.checkpoints.implement, after_sha: "done" },
        },
      },
    };
    assert.equal(reconcileTask(afterSha, {}).action, "advance_after_checkpoint");

    const beforeWithSession = {
      ...baseTask("implementing", "implement"),
      git: {
        ...baseTask().git,
        checkpoints: {
          ...baseTask().git.checkpoints,
          implement: { ...baseTask().git.checkpoints.implement, before_sha: "before" },
        },
      },
      provider_sessions: {
        ...baseTask().provider_sessions,
        implement: { codex_thread_id: "thread-1" },
      },
    };
    assert.equal(reconcileTask(beforeWithSession, {}).action, "resume_session");

    assert.equal(
      reconcileTask(baseTask("implementing", "implement"), {}).task.failure?.code,
      "pre_pr_active_orphan",
    );
  });
});

function baseTask(state: TaskEntry["state"], runtimePhase: TaskEntry["runtime_phase"]): TaskEntry {
  return {
    ...createTaskEntry({
      issue: 8,
      slug: "ak-007",
      title: "AK-007",
      labels: [],
      now: "2026-05-04T10:00:00+09:00",
    }),
    state,
    runtime_phase: runtimePhase,
  };
}

function prTask(
  state: TaskEntry["state"],
  runtimePhase: TaskEntry["runtime_phase"],
  headSha: string,
): TaskEntry {
  return {
    ...baseTask(state, runtimePhase),
    pr: { number: 28, head_sha: headSha, base_sha: "base", created_at: "now" },
    branch: "autokit/issue-8",
    worktree_path: ".autokit/worktrees/issue-8",
  };
}
