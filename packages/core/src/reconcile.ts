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
  prForBranch?: (PullRequestObservation & { number: number }) | { state: "NONE" };
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
  | "resume_session"
  | "restart_phase"
  | "commit_after_agent"
  | "push_after_commit"
  | "restore_pr_after_push"
  | "persist_head_after_pr"
  | "ready_pr_after_head"
  | "observe_fix_head_after_push"
  | "run_fix_after_rebase";

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
    return reconcilePrePrActiveTask(task, observation);
  }

  return { task: cloneTask(task), action: "none" };
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

function reconcilePrePrActiveTask(
  task: TaskEntry,
  observation: ReconcileObservation,
): ReconcileResult {
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
    if (phase === "implement" && task.pr.number === null) {
      const result = reconcileImplementPrePrCheckpoint(task, observation);
      if (result !== null) {
        return result;
      }
    }
    return reconcileAgentCheckpoint(task);
  }
  return {
    task: transitionTask(task, {
      type: "pause",
      failure: failure("pre_pr_active_orphan", phase ?? task.state),
    }),
    action: "none",
  };
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
  if (task.pr.head_sha !== null && (pr.headRefOid === null || pr.headRefOid !== task.pr.head_sha)) {
    return {
      task: transitionTask(task, {
        type: "pause",
        failure: failure("merge_sha_mismatch", task.runtime_phase ?? task.state),
      }),
      action: "none",
    };
  }
  if (task.runtime_phase === "ci_wait" || task.runtime_phase === "merge") {
    return { task: cloneTask(task), action: "resume_phase" };
  }
  return reconcileAgentCheckpoint(task);
}

function reconcileAgentCheckpoint(task: TaskEntry): ReconcileResult {
  const phase = task.runtime_phase;
  if (phase === null || phase === "ci_wait" || phase === "merge") {
    return { task: cloneTask(task), action: "none" };
  }
  if (phase === "implement") {
    return reconcileImplementCheckpoint(task);
  }
  if (phase === "fix") {
    return reconcileFixCheckpoint(task);
  }

  const checkpoint = task.git.checkpoints[phase];
  if (checkpoint.after_sha !== null) {
    return { task: cloneTask(task), action: "advance_after_checkpoint" };
  }
  if (checkpoint.before_sha !== null && hasProviderSession(task, phase)) {
    return { task: cloneTask(task), action: "resume_session" };
  }
  if (checkpoint.before_sha !== null) {
    return { task: cloneTask(task), action: "restart_phase" };
  }
  return {
    task: transitionTask(task, {
      type: "pause",
      failure: failure("pre_pr_active_orphan", phase),
    }),
    action: "none",
  };
}

function reconcileImplementCheckpoint(task: TaskEntry): ReconcileResult {
  const checkpoint = task.git.checkpoints.implement;
  if (checkpoint.after_sha !== null) {
    return { task: cloneTask(task), action: "advance_after_checkpoint" };
  }
  if (checkpoint.head_sha_persisted !== null) {
    return { task: cloneTask(task), action: "ready_pr_after_head" };
  }
  if (checkpoint.pr_created !== null) {
    return { task: cloneTask(task), action: "persist_head_after_pr" };
  }
  if (checkpoint.push_done !== null) {
    return { task: cloneTask(task), action: "restore_pr_after_push" };
  }
  if (checkpoint.commit_done !== null) {
    return { task: cloneTask(task), action: "push_after_commit" };
  }
  if (checkpoint.agent_done !== null) {
    return { task: cloneTask(task), action: "commit_after_agent" };
  }
  if (checkpoint.before_sha !== null && hasProviderSession(task, "implement")) {
    return { task: cloneTask(task), action: "resume_session" };
  }
  if (checkpoint.before_sha !== null) {
    return { task: cloneTask(task), action: "restart_phase" };
  }
  return {
    task: transitionTask(task, {
      type: "pause",
      failure: failure("pre_pr_active_orphan", "implement"),
    }),
    action: "none",
  };
}

function reconcileImplementPrePrCheckpoint(
  task: TaskEntry,
  observation: ReconcileObservation,
): ReconcileResult | null {
  const checkpoint = task.git.checkpoints.implement;
  if (checkpoint.push_done === null || observation.prForBranch === undefined) {
    return null;
  }
  if (observation.prForBranch.state === "NONE" || observation.prForBranch.state === "CLOSED") {
    return {
      task: transitionTask(task, {
        type: "pause",
        failure: failure("pre_pr_active_orphan", "implement"),
      }),
      action: "none",
    };
  }
  if (observation.prForBranch.state === "MERGED") {
    return {
      task: transitionTask(task, {
        type: "pause",
        failure: failure("pre_pr_active_orphan", "implement"),
      }),
      action: "none",
    };
  }
  const next = cloneTask(task);
  next.pr.number = observation.prForBranch.number;
  next.pr.head_sha = observation.prForBranch.headRefOid;
  next.git.checkpoints.implement.pr_created = observation.prForBranch.number;
  return { task: next, action: "persist_head_after_pr" };
}

function reconcileFixCheckpoint(task: TaskEntry): ReconcileResult {
  const checkpoint = task.git.checkpoints.fix;
  if (checkpoint.after_sha !== null) {
    return { task: cloneTask(task), action: "advance_after_checkpoint" };
  }
  if (checkpoint.head_sha_persisted !== null) {
    return { task: cloneTask(task), action: "advance_after_checkpoint" };
  }
  if (checkpoint.push_done !== null) {
    return { task: cloneTask(task), action: "observe_fix_head_after_push" };
  }
  if (checkpoint.commit_done !== null) {
    return { task: cloneTask(task), action: "push_after_commit" };
  }
  if (checkpoint.agent_done !== null) {
    return { task: cloneTask(task), action: "commit_after_agent" };
  }
  if (checkpoint.rebase_done !== null) {
    return { task: cloneTask(task), action: "run_fix_after_rebase" };
  }
  if (checkpoint.before_sha !== null && hasProviderSession(task, "fix")) {
    return { task: cloneTask(task), action: "resume_session" };
  }
  if (checkpoint.before_sha !== null) {
    return { task: cloneTask(task), action: "restart_phase" };
  }
  return {
    task: transitionTask(task, {
      type: "pause",
      failure: failure("pre_pr_active_orphan", "fix"),
    }),
    action: "none",
  };
}

function hasProviderSession(
  task: TaskEntry,
  phase: Exclude<NonNullable<TaskEntry["runtime_phase"]>, "ci_wait" | "merge">,
): boolean {
  const session = task.provider_sessions[phase];
  return session.claude_session_id !== null || session.codex_session_id !== null;
}

function failure(
  code: NonNullable<TaskEntry["failure"]>["code"],
  phase: string,
): NonNullable<TaskEntry["failure"]> {
  return { phase, code, message: code, ts: new Date().toISOString() };
}
