import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { retryCleanupTask } from "./retry-cleanup.ts";
import { createTaskEntry, type TaskEntry } from "./tasks.ts";

describe("core retry cleanup", () => {
  it("runs cleanup steps once, clears PR/worktree/runtime fields, and queues the task", () => {
    const calls: string[] = [];
    const result = retryCleanupTask(failedTask(), {
      closePr: () => calls.push("closePr"),
      removeWorktree: () => calls.push("removeWorktree"),
      deleteBranch: () => calls.push("deleteBranch"),
      persistTask: (task) => calls.push(`persist:${task.retry.cleanup_progress?.fields_cleared}`),
      audit: (kind) => calls.push(`audit:${kind}`),
    });

    assert.equal(result.state, "queued");
    assert.equal(result.pr.number, null);
    assert.equal(result.branch, null);
    assert.equal(result.worktree_path, null);
    assert.equal(result.runtime_phase, null);
    assert.equal(result.runtime.resolved_effort, null);
    assert.equal(result.runtime.phase_self_correct_done, null);
    assert.equal(result.runtime.phase_override, null);
    assert.equal(result.retry.cleanup_progress, null);
    assert.deepEqual(calls, [
      "closePr",
      "persist:false",
      "audit:retry_pr_closed",
      "removeWorktree",
      "persist:false",
      "deleteBranch",
      "persist:false",
      "persist:true",
      "persist:undefined",
    ]);
  });

  it("forward-resumes from existing cleanup_progress and skips completed steps", () => {
    const task = {
      ...failedTask(),
      retry: {
        started_at: "earlier",
        cleanup_progress: {
          pr_closed: true,
          worktree_removed: false,
          branch_deleted: false,
          fields_cleared: false,
        },
      },
    };
    const calls: string[] = [];
    const result = retryCleanupTask(task, {
      closePr: () => calls.push("closePr"),
      removeWorktree: () => calls.push("removeWorktree"),
      deleteBranch: () => calls.push("deleteBranch"),
      persistTask: () => calls.push("persist"),
      audit: (kind) => calls.push(`audit:${kind}`),
    });

    assert.equal(result.state, "queued");
    assert.deepEqual(calls, [
      "audit:retry_resumed",
      "removeWorktree",
      "persist",
      "deleteBranch",
      "persist",
      "persist",
      "persist",
    ]);
  });

  it("pauses with retry_cleanup_failed while preserving completed flags on step failures", () => {
    const result = retryCleanupTask(failedTask(), {
      closePr: () => undefined,
      removeWorktree: () => {
        throw new Error("busy");
      },
      deleteBranch: () => undefined,
      persistTask: () => undefined,
      audit: () => undefined,
    });

    assert.equal(result.state, "paused");
    assert.equal(result.failure?.code, "retry_cleanup_failed");
    assert.equal(result.retry.cleanup_progress?.pr_closed, true);
    assert.equal(result.retry.cleanup_progress?.worktree_removed, false);
  });

  it("uses queue_corruption when field clearing atomic write fails", () => {
    const result = retryCleanupTask(failedTask(), {
      closePr: () => undefined,
      removeWorktree: () => undefined,
      deleteBranch: () => undefined,
      clearFields: () => {
        throw new Error("ENOSPC");
      },
      audit: () => undefined,
    });

    assert.equal(result.state, "paused");
    assert.equal(result.failure?.code, "queue_corruption");
  });

  it("uses queue_corruption when progress atomic write fails after a destructive step", () => {
    const result = retryCleanupTask(failedTask(), {
      closePr: () => undefined,
      persistTask: () => {
        throw new Error("RO-fs");
      },
    });

    assert.equal(result.state, "paused");
    assert.equal(result.failure?.code, "queue_corruption");
    assert.equal(result.retry.cleanup_progress?.pr_closed, true);
  });
});

function failedTask(): TaskEntry {
  return {
    ...createTaskEntry({
      issue: 8,
      slug: "ak-007",
      title: "AK-007",
      labels: [],
      now: "2026-05-04T10:00:00+09:00",
    }),
    state: "failed",
    runtime_phase: null,
    branch: "autokit/issue-8",
    worktree_path: ".autokit/worktrees/issue-8",
    pr: { number: 28, head_sha: "head", base_sha: "base", created_at: "now" },
    failure: { phase: "review", code: "review_max", message: "max", ts: "now" },
    runtime: {
      ...createTaskEntry({
        issue: 8,
        slug: "ak-007",
        title: "AK-007",
        labels: [],
        now: "2026-05-04T10:00:00+09:00",
      }).runtime,
      resolved_effort: {
        phase: "review",
        provider: "claude",
        effort: "high",
        downgraded_from: null,
        timeout_ms: 3_600_000,
      },
      phase_self_correct_done: true,
      phase_override: {
        phase: "fix",
        provider: "codex",
        effort: "medium",
        expires_at_run_id: "run-1",
      },
    },
  };
}
