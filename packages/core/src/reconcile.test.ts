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
        pr: { state: "MERGED", merged: true, headRefOid: null, mergeable: "UNKNOWN" },
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
      git: { ...baseTask().git, base_sha: "base" },
    };
    assert.equal(reconcileTask(plannedVerified, {}).task.state, "implementing");
    assert.equal(
      reconcileTask(
        {
          ...baseTask("planned", null),
          plan: { ...baseTask().plan, state: "verified" as const },
        },
        {},
      ).task.failure?.code,
      "pre_pr_active_orphan",
    );

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
        implement: { ...baseTask().provider_sessions.implement, codex_session_id: "thread-1" },
      },
    };
    assert.equal(reconcileTask(beforeWithSession, {}).action, "resume_session");

    const planWithDefaultProviderSession = {
      ...baseTask("planning", "plan"),
      git: {
        ...baseTask().git,
        checkpoints: {
          ...baseTask().git.checkpoints,
          plan: { ...baseTask().git.checkpoints.plan, before_sha: "before" },
        },
      },
      provider_sessions: {
        ...baseTask().provider_sessions,
        plan: { ...baseTask().provider_sessions.plan, claude_session_id: "claude-plan" },
      },
    };
    assert.equal(reconcileTask(planWithDefaultProviderSession, {}).action, "resume_session");

    const planWithReverseProviderOnlySession = {
      ...planWithDefaultProviderSession,
      provider_sessions: {
        ...baseTask().provider_sessions,
        plan: { ...baseTask().provider_sessions.plan, codex_session_id: "codex-plan" },
      },
    };
    assert.equal(reconcileTask(planWithReverseProviderOnlySession, {}).action, "restart_phase");

    assert.equal(
      reconcileTask(baseTask("implementing", "implement"), {}).task.failure?.code,
      "pre_pr_active_orphan",
    );
  });

  it("maps implement checkpoints to deterministic recovery actions", () => {
    const cases = [
      ["after_sha", "done", "advance_after_checkpoint"],
      ["head_sha_persisted", "head", "ready_pr_after_head"],
      ["pr_created", 51, "persist_head_after_pr"],
      ["push_done", "commit", "restore_pr_after_push"],
      ["commit_done", "commit", "push_after_commit"],
      ["agent_done", "agent", "commit_after_agent"],
      ["before_sha", "before", "restart_phase"],
    ] as const;

    for (const [key, value, action] of cases) {
      assert.equal(reconcileTask(implementCheckpointTask({ [key]: value }), {}).action, action);
    }

    assert.equal(
      reconcileTask(implementCheckpointTask({ before_sha: "before" }, true), {}).action,
      "resume_session",
    );
  });

  it("restores an implement PR after push when GitHub still has the branch PR", () => {
    const result = reconcileTask(implementCheckpointTask({ push_done: "commit" }), {
      prForBranch: {
        number: 88,
        state: "OPEN",
        merged: false,
        headRefOid: "remote-head",
        mergeable: "MERGEABLE",
      },
    });

    assert.equal(result.action, "persist_head_after_pr");
    assert.equal(result.task.pr.number, 88);
    assert.equal(result.task.pr.head_sha, "remote-head");
    assert.equal(result.task.git.checkpoints.implement.pr_created, 88);

    assert.equal(
      reconcileTask(implementCheckpointTask({ push_done: "commit" }), {
        prForBranch: { state: "NONE" },
      }).task.failure?.code,
      "pre_pr_active_orphan",
    );
  });

  it("maps fix checkpoints to deterministic recovery actions", () => {
    const cases = [
      ["after_sha", "done", "advance_after_checkpoint"],
      ["head_sha_persisted", "head", "advance_after_checkpoint"],
      ["push_done", "commit", "observe_fix_head_after_push"],
      ["commit_done", "commit", "push_after_commit"],
      ["agent_done", "agent", "commit_after_agent"],
      ["rebase_done", "base", "run_fix_after_rebase"],
      ["before_sha", "before", "restart_phase"],
    ] as const;

    for (const [key, value, action] of cases) {
      assert.equal(reconcileTask(fixCheckpointTask({ [key]: value }), openPr()).action, action);
    }

    assert.equal(
      reconcileTask(fixCheckpointTask({ before_sha: "before" }, true), openPr()).action,
      "resume_session",
    );
  });
});

function baseTask(
  state: TaskEntry["state"] = "queued",
  runtimePhase: TaskEntry["runtime_phase"] = null,
): TaskEntry {
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

function implementCheckpointTask(
  checkpoint: Partial<TaskEntry["git"]["checkpoints"]["implement"]>,
  withSession = false,
): TaskEntry {
  return {
    ...baseTask("implementing", "implement"),
    git: {
      ...baseTask().git,
      checkpoints: {
        ...baseTask().git.checkpoints,
        implement: { ...baseTask().git.checkpoints.implement, ...checkpoint },
      },
    },
    provider_sessions: {
      ...baseTask().provider_sessions,
      implement: {
        ...baseTask().provider_sessions.implement,
        codex_session_id: withSession ? "thread-1" : null,
      },
    },
  };
}

function fixCheckpointTask(
  checkpoint: Partial<TaskEntry["git"]["checkpoints"]["fix"]>,
  withSession = false,
): TaskEntry {
  return {
    ...prTask("fixing", "fix", "head"),
    fix: { origin: "review", started_at: "now" },
    git: {
      ...baseTask().git,
      checkpoints: {
        ...baseTask().git.checkpoints,
        fix: { ...baseTask().git.checkpoints.fix, ...checkpoint },
      },
    },
    provider_sessions: {
      ...baseTask().provider_sessions,
      fix: {
        ...baseTask().provider_sessions.fix,
        codex_session_id: withSession ? "thread-1" : null,
      },
    },
  };
}

function openPr() {
  return {
    pr: {
      state: "OPEN" as const,
      merged: false,
      headRefOid: "head",
      mergeable: "MERGEABLE" as const,
    },
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
