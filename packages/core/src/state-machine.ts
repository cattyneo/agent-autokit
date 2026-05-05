import type { AutokitConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import {
  cloneTask,
  makeFailure,
  type TaskEntry,
  type TaskRuntimePhase,
  type TaskState,
} from "./tasks.ts";

export type TransitionEvent =
  | { type: "run_started"; resolvedModels?: Record<string, string> }
  | { type: "plan_completed" }
  | { type: "plan_verify_accepted" }
  | { type: "plan_verify_rejected" }
  | { type: "plan_fix_completed" }
  | { type: "implement_started"; beforeSha: string }
  | { type: "pr_ready"; headSha: string; prNumber?: number; baseSha?: string }
  | { type: "review_completed" }
  | { type: "supervise_accept"; origin: "review" }
  | { type: "supervise_no_findings" }
  | { type: "supervise_reject_all" }
  | { type: "fix_pushed" }
  | { type: "ci_failed" }
  | { type: "ci_passed_auto_merge" }
  | { type: "ci_passed_manual_merge" }
  | { type: "ci_head_mismatch" }
  | { type: "ci_branch_protection" }
  | { type: "ci_timeout" }
  | { type: "auto_merge_reserved" }
  | { type: "pr_merged"; headSha: string | null }
  | { type: "merge_blocked" }
  | { type: "merge_timeout" }
  | { type: "pr_closed_unmerged" }
  | { type: "cleaning_completed" }
  | { type: "cleaning_branch_failed"; message: string }
  | { type: "cleaning_worktree_failed"; message: string }
  | { type: "pause"; failure: NonNullable<TaskEntry["failure"]> }
  | { type: "fail"; failure: NonNullable<TaskEntry["failure"]> }
  | { type: "resume" }
  | { type: "retry_reset" };

export function transitionTask(
  input: TaskEntry,
  event: TransitionEvent,
  config: AutokitConfig = DEFAULT_CONFIG,
): TaskEntry {
  const task = cloneTask(input);

  switch (event.type) {
    case "run_started":
      task.state = "planning";
      task.runtime_phase = "plan";
      task.timestamps.started_at ??= new Date().toISOString();
      if (event.resolvedModels !== undefined) {
        for (const [phase, model] of Object.entries(event.resolvedModels)) {
          if (phase in task.runtime.resolved_model) {
            task.runtime.resolved_model[phase as keyof typeof task.runtime.resolved_model] = model;
          }
        }
      }
      resetPhaseAttempt(task);
      return task;
    case "plan_completed":
      task.runtime_phase = "plan_verify";
      resetPhaseAttempt(task);
      return task;
    case "plan_verify_accepted":
      task.state = "planned";
      task.runtime_phase = null;
      task.plan.state = "verified";
      task.plan.verified_at = new Date().toISOString();
      resetPhaseAttempt(task);
      return task;
    case "plan_verify_rejected":
      if (task.plan.plan_verify_round + 1 > config.plan.max_rounds) {
        return fail(task, "plan_max", "plan verification round limit exceeded");
      }
      task.plan.plan_verify_round += 1;
      task.runtime_phase = "plan_fix";
      task.provider_sessions.plan_verify.codex_session_id = null;
      task.provider_sessions.plan_fix.claude_session_id = null;
      resetPhaseAttempt(task);
      return task;
    case "plan_fix_completed":
      task.runtime_phase = "plan_verify";
      resetPhaseAttempt(task);
      return task;
    case "implement_started":
      task.state = "implementing";
      task.runtime_phase = "implement";
      task.git.checkpoints.implement.before_sha = event.beforeSha;
      return task;
    case "pr_ready":
      task.state = "reviewing";
      task.runtime_phase = "review";
      resetReviewPhase(task);
      task.pr.number = event.prNumber ?? task.pr.number;
      task.pr.head_sha = event.headSha;
      task.pr.base_sha = event.baseSha ?? task.pr.base_sha;
      task.git.checkpoints.implement.after_sha = event.headSha;
      return task;
    case "review_completed":
      task.runtime_phase = "supervise";
      resetSupervisePhase(task);
      return task;
    case "supervise_accept":
      if (task.review_round + 1 > config.review.max_rounds) {
        return fail(task, "review_max", "review round limit exceeded");
      }
      task.review_round += 1;
      task.state = "fixing";
      task.runtime_phase = "fix";
      task.fix.origin = event.origin;
      resetFixPhase(task);
      return task;
    case "supervise_no_findings":
    case "supervise_reject_all":
      task.state = "ci_waiting";
      task.runtime_phase = "ci_wait";
      return task;
    case "fix_pushed":
      task.state = "reviewing";
      task.runtime_phase = "review";
      task.fix.origin = null;
      resetReviewPhase(task);
      return task;
    case "ci_failed":
      if (task.ci_fix_round + 1 > config.ci.fix_max_rounds) {
        return fail(task, "ci_failure_max", "CI failure round limit exceeded", "ci_wait");
      }
      task.ci_fix_round += 1;
      task.state = "fixing";
      task.runtime_phase = "fix";
      task.fix.origin = "ci";
      resetFixPhase(task);
      return task;
    case "ci_passed_auto_merge":
    case "auto_merge_reserved":
      task.state = "merging";
      task.runtime_phase = "merge";
      return task;
    case "ci_passed_manual_merge":
      return pause(task, "manual_merge_required", "manual merge required", "ci_wait");
    case "ci_head_mismatch":
      return pause(task, "merge_sha_mismatch", "PR head SHA changed", "ci_wait");
    case "ci_branch_protection":
      return pause(task, "branch_protection", "branch protection blocks merge", "ci_wait");
    case "ci_timeout":
      return config.ci.timeout_action === "failed"
        ? fail(task, "ci_timeout", "CI wait timed out", "ci_wait")
        : pause(task, "ci_timeout", "CI wait timed out", "ci_wait");
    case "pr_merged":
      if (
        task.pr.head_sha === null ||
        event.headSha === null ||
        event.headSha !== task.pr.head_sha
      ) {
        return pause(task, "merge_sha_mismatch", "merged PR head SHA mismatch", "merge");
      }
      task.state = "cleaning";
      task.runtime_phase = null;
      return task;
    case "merge_blocked":
      return pause(task, "branch_protection", "merge became blocked", "merge");
    case "merge_timeout":
      return pause(task, "merge_timeout", "merge timed out", "merge");
    case "pr_closed_unmerged":
      return pause(task, "other", "PR closed without merge", "merge");
    case "cleaning_completed":
      task.state = "merged";
      task.runtime_phase = null;
      task.cleaning_progress.finalized_done = true;
      task.timestamps.completed_at = new Date().toISOString();
      return task;
    case "cleaning_branch_failed":
      return pause(task, "branch_delete_failed", event.message, "cleaning");
    case "cleaning_worktree_failed":
      return pause(task, "worktree_remove_failed", event.message, "cleaning");
    case "pause":
      return pauseWithFailure(task, event.failure);
    case "fail":
      return failWithFailure(task, event.failure);
    case "resume":
      task.state = task.runtime.previous_state ?? task.state;
      task.failure = null;
      return task;
    case "retry_reset":
      task.state = "queued";
      task.runtime_phase = null;
      task.failure = null;
      task.failure_history = [];
      task.runtime.phase_attempt = 0;
      return task;
  }
}

export function isActiveState(state: TaskState): boolean {
  return !["paused", "failed", "merged"].includes(state);
}

export function isAgentRuntimePhase(
  phase: TaskRuntimePhase | null,
): phase is Exclude<TaskRuntimePhase, "ci_wait" | "merge"> {
  return phase !== null && phase !== "ci_wait" && phase !== "merge";
}

function pause(
  task: TaskEntry,
  code: NonNullable<TaskEntry["failure"]>["code"],
  message: string,
  phase: string = task.runtime_phase ?? task.state,
): TaskEntry {
  return pauseWithFailure(task, makeFailure({ phase, code, message }));
}

function fail(
  task: TaskEntry,
  code: NonNullable<TaskEntry["failure"]>["code"],
  message: string,
  phase: string = task.runtime_phase ?? task.state,
): TaskEntry {
  return failWithFailure(task, makeFailure({ phase, code, message }));
}

function pauseWithFailure(task: TaskEntry, failure: NonNullable<TaskEntry["failure"]>): TaskEntry {
  if (task.state === "paused" && task.failure !== null) {
    pushFailureHistory(task, failure);
    return task;
  }
  task.runtime.previous_state = isActiveState(task.state)
    ? task.state
    : task.runtime.previous_state;
  task.state = "paused";
  task.failure = failure;
  if (failure.code === "interrupted") {
    task.runtime.interrupted_at = failure.ts;
  }
  pushFailureHistory(task, failure);
  return task;
}

function failWithFailure(task: TaskEntry, failure: NonNullable<TaskEntry["failure"]>): TaskEntry {
  task.state = "failed";
  task.runtime_phase = null;
  task.failure = failure;
  return task;
}

function pushFailureHistory(task: TaskEntry, failure: NonNullable<TaskEntry["failure"]>): void {
  if (task.failure_history.length === 0 && task.failure !== null) {
    task.failure_history.push(task.failure);
  }
  if (task.failure_history.at(-1) !== failure) {
    task.failure_history.push(failure);
  }
  while (task.failure_history.length > 10) {
    task.failure_history.splice(1, 1);
    task.failure_history_truncated_count += 1;
  }
}

function resetPhaseAttempt(task: TaskEntry): void {
  task.runtime.phase_attempt = 0;
}

function resetReviewPhase(task: TaskEntry): void {
  task.git.checkpoints.review = { before_sha: null, after_sha: null };
  task.provider_sessions.review.claude_session_id = null;
}

function resetSupervisePhase(task: TaskEntry): void {
  task.git.checkpoints.supervise = { before_sha: null, after_sha: null };
  task.provider_sessions.supervise.claude_session_id = null;
}

function resetFixPhase(task: TaskEntry): void {
  task.git.checkpoints.fix = {
    before_sha: null,
    rebase_done: null,
    agent_done: null,
    commit_done: null,
    push_done: null,
    pr_created: null,
    head_sha_persisted: null,
    after_sha: null,
  };
  task.provider_sessions.fix.codex_session_id = null;
}
