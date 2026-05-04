import { transitionTask } from "./state-machine.ts";
import { cloneTask, type TaskEntry } from "./tasks.ts";

export type PullRequestObservation = {
  state: "OPEN" | "MERGED" | "CLOSED";
  merged: boolean;
  headRefOid: string | null;
  mergeable: "MERGEABLE" | "BLOCKED" | "UNKNOWN";
};

export type ReconcileObservation = {
  pr?: PullRequestObservation;
  branchExists?: boolean;
  worktreeExists?: boolean;
  branchDeleteFailed?: boolean;
  worktreeRemoveFailed?: boolean;
};

export type ReconcileAction =
  | "none"
  | "resume_phase"
  | "cleanup_remaining"
  | "advance_after_checkpoint"
  | "resume_session";

export type ReconcileResult = {
  task: TaskEntry;
  action: ReconcileAction;
};

export function reconcileTask(task: TaskEntry, observation: ReconcileObservation): ReconcileResult {
  if (task.state === "cleaning") {
    return reconcileCleaning(task, observation);
  }

  if (task.pr.number !== null && observation.pr !== undefined) {
    return reconcilePrBackedTask(task, observation.pr);
  }

  if (
    task.pr.number === null &&
    ["planning", "planned", "implementing", "reviewing"].includes(task.state)
  ) {
    return reconcilePrePrActiveTask(task);
  }

  return { task: cloneTask(task), action: "none" };
}

function reconcilePrBackedTask(task: TaskEntry, pr: PullRequestObservation): ReconcileResult {
  if (pr.state === "MERGED" && pr.merged) {
    if (task.pr.head_sha === null || pr.headRefOid === null || pr.headRefOid !== task.pr.head_sha) {
      return {
        task: transitionTask(task, {
          type: "pause",
          failure: failure("merge_sha_mismatch", "merge"),
        }),
        action: "none",
      };
    }
    return {
      task: transitionTask(task, { type: "pr_merged", headSha: pr.headRefOid }),
      action: "cleanup_remaining",
    };
  }
  if (pr.state === "CLOSED") {
    return {
      task: transitionTask(task, {
        type: "pause",
        failure: failure("other", task.runtime_phase ?? task.state),
      }),
      action: "none",
    };
  }
  if (task.pr.head_sha === null || pr.headRefOid === null || pr.headRefOid !== task.pr.head_sha) {
    return {
      task: transitionTask(task, {
        type: "pause",
        failure: failure("merge_sha_mismatch", task.runtime_phase ?? task.state),
      }),
      action: "none",
    };
  }
  return { task: cloneTask(task), action: "resume_phase" };
}

function reconcileCleaning(task: TaskEntry, observation: ReconcileObservation): ReconcileResult {
  if (observation.branchDeleteFailed) {
    return {
      task: transitionTask(task, {
        type: "cleaning_branch_failed",
        message: "remote branch deletion failed",
      }),
      action: "none",
    };
  }
  if (observation.worktreeRemoveFailed) {
    return {
      task: transitionTask(task, {
        type: "cleaning_worktree_failed",
        message: "worktree removal failed",
      }),
      action: "none",
    };
  }
  if (observation.branchExists === false && observation.worktreeExists === false) {
    return { task: transitionTask(task, { type: "cleaning_completed" }), action: "none" };
  }
  return { task: cloneTask(task), action: "cleanup_remaining" };
}

function reconcilePrePrActiveTask(task: TaskEntry): ReconcileResult {
  if (task.state === "planned") {
    if (task.plan.state === "verified" && task.runtime_phase === null) {
      if (task.git.base_sha === null) {
        return {
          task: transitionTask(task, {
            type: "pause",
            failure: failure("pre_pr_active_orphan", "planned"),
          }),
          action: "none",
        };
      }
      return {
        task: transitionTask(task, {
          type: "implement_started",
          beforeSha: task.git.base_sha,
        }),
        action: "none",
      };
    }
    return {
      task: transitionTask(task, {
        type: "pause",
        failure: failure("pre_pr_active_orphan", "planned"),
      }),
      action: "none",
    };
  }

  const phase = task.runtime_phase;
  if (phase !== null && phase !== "ci_wait" && phase !== "merge") {
    const checkpoint = task.git.checkpoints[phase];
    if (checkpoint.after_sha !== null) {
      return { task: cloneTask(task), action: "advance_after_checkpoint" };
    }
    if (checkpoint.before_sha !== null && hasProviderSession(task, phase)) {
      return { task: cloneTask(task), action: "resume_session" };
    }
  }
  return {
    task: transitionTask(task, {
      type: "pause",
      failure: failure("pre_pr_active_orphan", phase ?? task.state),
    }),
    action: "none",
  };
}

function hasProviderSession(
  task: TaskEntry,
  phase: Exclude<NonNullable<TaskEntry["runtime_phase"]>, "ci_wait" | "merge">,
): boolean {
  const session = task.provider_sessions[phase];
  return Object.values(session).some((value) => value !== null);
}

function failure(
  code: NonNullable<TaskEntry["failure"]>["code"],
  phase: string,
): NonNullable<TaskEntry["failure"]> {
  return { phase, code, message: code, ts: new Date().toISOString() };
}
