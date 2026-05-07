import { transitionTask } from "./state-machine.ts";
import {
  cloneTask,
  emptyProviderSession,
  type RetryCleanupProgress,
  type TaskEntry,
} from "./tasks.ts";

export type RetryCleanupDeps = {
  closePr?: (task: TaskEntry) => void;
  removeWorktree?: (task: TaskEntry) => void;
  deleteBranch?: (task: TaskEntry) => void;
  clearFields?: (task: TaskEntry) => void;
  persistTask?: (task: TaskEntry) => void;
  audit?: (kind: "retry_pr_closed" | "retry_resumed") => void;
};

export function retryCleanupTask(input: TaskEntry, deps: RetryCleanupDeps): TaskEntry {
  const task = cloneTask(input);
  const resumed = task.retry.cleanup_progress !== null;
  task.retry.cleanup_progress ??= {
    pr_closed: false,
    worktree_removed: false,
    branch_deleted: false,
    fields_cleared: false,
  };
  task.retry.started_at ??= new Date().toISOString();

  if (resumed) {
    deps.audit?.("retry_resumed");
  }

  if (!task.retry.cleanup_progress.pr_closed) {
    try {
      if (task.pr.number !== null) {
        deps.closePr?.(task);
      }
      const persistFailure = markProgress(task, deps, "pr_closed");
      if (persistFailure !== null) {
        return persistFailure;
      }
      if (task.pr.number !== null) {
        deps.audit?.("retry_pr_closed");
      }
    } catch (error) {
      return pauseRetryFailure(task, error);
    }
  }

  if (!task.retry.cleanup_progress.worktree_removed) {
    try {
      if (task.worktree_path !== null) {
        deps.removeWorktree?.(task);
      }
      const persistFailure = markProgress(task, deps, "worktree_removed");
      if (persistFailure !== null) {
        return persistFailure;
      }
    } catch (error) {
      return pauseRetryFailure(task, error);
    }
  }

  if (!task.retry.cleanup_progress.branch_deleted) {
    try {
      if (task.branch !== null) {
        deps.deleteBranch?.(task);
      }
      const persistFailure = markProgress(task, deps, "branch_deleted");
      if (persistFailure !== null) {
        return persistFailure;
      }
    } catch (error) {
      return pauseRetryFailure(task, error);
    }
  }

  try {
    deps.clearFields?.(task);
    clearRetryFields(task);
    const persistFailure = markProgress(task, deps, "fields_cleared");
    if (persistFailure !== null) {
      return persistFailure;
    }
  } catch (error) {
    return pauseQueueCorruption(task, error);
  }

  const progress = task.retry.cleanup_progress satisfies RetryCleanupProgress;
  if (
    progress.pr_closed &&
    progress.worktree_removed &&
    progress.branch_deleted &&
    progress.fields_cleared
  ) {
    task.retry.cleanup_progress = null;
    task.retry.started_at = null;
    task.state = "queued";
    const persistFailure = persistTask(task, deps);
    if (persistFailure !== null) {
      return persistFailure;
    }
  }
  return task;
}

function persistTask(task: TaskEntry, deps: RetryCleanupDeps): TaskEntry | null {
  try {
    deps.persistTask?.(task);
    return null;
  } catch (error) {
    return pauseQueueCorruption(task, error);
  }
}

function markProgress(
  task: TaskEntry,
  deps: RetryCleanupDeps,
  key: keyof RetryCleanupProgress,
): TaskEntry | null {
  if (task.retry.cleanup_progress === null) {
    return null;
  }
  task.retry.cleanup_progress[key] = true;
  return persistTask(task, deps);
}

function pauseRetryFailure(task: TaskEntry, error: unknown): TaskEntry {
  return transitionTask(task, {
    type: "pause",
    failure: {
      phase: "retry",
      code: "retry_cleanup_failed",
      message: error instanceof Error ? error.message : String(error),
      ts: new Date().toISOString(),
    },
  });
}

function pauseQueueCorruption(task: TaskEntry, error: unknown): TaskEntry {
  return transitionTask(task, {
    type: "pause",
    failure: {
      phase: "retry",
      code: "queue_corruption",
      message: error instanceof Error ? error.message : String(error),
      ts: new Date().toISOString(),
    },
  });
}

function clearRetryFields(task: TaskEntry): void {
  task.provider_sessions = {
    plan: emptyProviderSession(),
    plan_verify: emptyProviderSession(),
    plan_fix: emptyProviderSession(),
    implement: emptyProviderSession(),
    review: emptyProviderSession(),
    supervise: emptyProviderSession(),
    fix: emptyProviderSession(),
  };
  task.git.base_sha = null;
  for (const checkpoint of Object.values(task.git.checkpoints)) {
    for (const key of Object.keys(checkpoint) as Array<keyof typeof checkpoint>) {
      checkpoint[key] = null;
    }
  }
  task.pr = { number: null, head_sha: null, base_sha: null, created_at: null };
  task.branch = null;
  task.worktree_path = null;
  task.review_findings = [];
  task.reject_history = [];
  task.failure = null;
  task.failure_history = [];
  task.runtime_phase = null;
  task.runtime.phase_attempt = 0;
  task.runtime.previous_state = null;
  task.runtime.interrupted_at = null;
  task.runtime.last_event_id = null;
  task.runtime.resolved_effort = null;
  task.runtime.phase_self_correct_done = null;
  task.runtime.phase_override = null;
  for (const phase of Object.keys(task.runtime.resolved_model) as Array<
    keyof typeof task.runtime.resolved_model
  >) {
    task.runtime.resolved_model[phase] = null;
  }
  task.review_round = 0;
  task.ci_fix_round = 0;
  task.fix = { origin: null, started_at: null, ci_failure_log: null };
}
