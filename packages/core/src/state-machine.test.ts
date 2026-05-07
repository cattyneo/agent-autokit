import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG, parseConfig } from "./config.ts";
import { isAgentRuntimePhase, transitionTask } from "./state-machine.ts";
import { createTaskEntry, type TaskEntry } from "./tasks.ts";

describe("core state machine", () => {
  it("covers the planned flow edges and max-round boundaries", () => {
    let task = baseTask();

    task = transitionTask(task, { type: "run_started", resolvedModels: resolvedModels() });
    assert.equal(task.state, "planning");
    assert.equal(task.runtime_phase, "plan");
    assert.equal(task.runtime.resolved_model.fix, "codex:fix");

    task = transitionTask(task, { type: "plan_completed" });
    assert.equal(task.runtime_phase, "plan_verify");
    task.provider_sessions.plan_verify.codex_session_id = "codex-old-plan-verify";
    task.provider_sessions.plan_fix.claude_session_id = "claude-old-plan-fix";
    task.runtime.phase_attempt = 2;

    task = transitionTask(task, { type: "plan_verify_rejected" }, DEFAULT_CONFIG);
    assert.equal(task.runtime_phase, "plan_fix");
    assert.equal(task.plan.plan_verify_round, 1);
    assert.equal(task.provider_sessions.plan_verify.codex_session_id, null);
    assert.equal(task.provider_sessions.plan_fix.claude_session_id, null);
    assert.equal(task.runtime.phase_attempt, 0);
    task.runtime.phase_attempt = 2;

    task = transitionTask(task, { type: "plan_fix_completed" });
    assert.equal(task.runtime_phase, "plan_verify");
    assert.equal(task.runtime.phase_attempt, 0);
    assert.equal(task.runtime.phase_self_correct_done, false);

    task = transitionTask(task, { type: "plan_verify_accepted" });
    assert.equal(task.state, "planned");
    assert.equal(task.runtime_phase, null);
    assert.equal(task.plan.state, "verified");

    task = transitionTask(task, { type: "implement_started", beforeSha: "base" });
    assert.equal(task.state, "implementing");
    assert.equal(task.runtime_phase, "implement");
    assert.equal(task.git.checkpoints.implement.before_sha, "base");

    task = transitionTask(task, { type: "pr_ready", headSha: "head" });
    assert.equal(task.state, "reviewing");
    assert.equal(task.runtime_phase, "review");
    assert.equal(task.pr.head_sha, "head");

    task = transitionTask(task, { type: "review_completed" });
    assert.equal(task.runtime_phase, "supervise");

    task = transitionTask(task, { type: "supervise_accept", origin: "review" }, DEFAULT_CONFIG);
    assert.equal(task.state, "fixing");
    assert.equal(task.runtime_phase, "fix");
    assert.equal(task.review_round, 1);
    assert.equal(task.fix.origin, "review");

    task = transitionTask(task, { type: "fix_pushed" });
    assert.equal(task.state, "reviewing");
    assert.equal(task.fix.origin, null);

    task = { ...task, review_round: 3 };
    const failed = transitionTask(
      task,
      { type: "supervise_accept", origin: "review" },
      DEFAULT_CONFIG,
    );
    assert.equal(failed.state, "failed");
    assert.equal(failed.failure?.code, "review_max");
  });

  it("handles CI/merge/cleaning edges and failure codes", () => {
    let task = { ...baseTask(), state: "ci_waiting" as const, runtime_phase: "ci_wait" as const };

    task = transitionTask(task, { type: "ci_failed" }, DEFAULT_CONFIG);
    assert.equal(task.state, "fixing");
    assert.equal(task.ci_fix_round, 1);
    assert.equal(task.fix.origin, "ci");

    const failedCi = transitionTask(
      { ...task, state: "ci_waiting", runtime_phase: "ci_wait", ci_fix_round: 3 },
      { type: "ci_failed" },
      DEFAULT_CONFIG,
    );
    assert.equal(failedCi.state, "failed");
    assert.equal(failedCi.failure?.code, "ci_failure_max");

    const manual = transitionTask(task, { type: "ci_passed_manual_merge" });
    assert.equal(manual.state, "paused");
    assert.equal(manual.failure?.code, "manual_merge_required");
    assert.equal(
      transitionTask(task, { type: "ci_head_mismatch" }).failure?.code,
      "merge_sha_mismatch",
    );
    assert.equal(
      transitionTask(task, { type: "ci_branch_protection" }).failure?.code,
      "branch_protection",
    );
    assert.equal(transitionTask(task, { type: "ci_timeout" }).failure?.code, "ci_timeout");
    assert.equal(
      transitionTask(
        task,
        { type: "ci_timeout" },
        parseConfig({ ci: { timeout_action: "failed" } }),
      ).state,
      "failed",
    );

    task = { ...task, pr: { ...task.pr, head_sha: "head" } };
    const merging = transitionTask(task, { type: "auto_merge_reserved" });
    assert.equal(merging.state, "merging");
    assert.equal(merging.runtime_phase, "merge");

    const cleaning = transitionTask(merging, { type: "pr_merged", headSha: merging.pr.head_sha });
    assert.equal(cleaning.state, "cleaning");
    assert.equal(cleaning.runtime_phase, null);
    assert.equal(
      transitionTask(
        { ...merging, pr: { ...merging.pr, head_sha: "expected" } },
        {
          type: "pr_merged",
          headSha: "actual",
        },
      ).failure?.code,
      "merge_sha_mismatch",
    );
    assert.equal(
      transitionTask(
        { ...merging, pr: { ...merging.pr, head_sha: "expected" } },
        {
          type: "pr_merged",
          headSha: null,
        },
      ).failure?.code,
      "merge_sha_mismatch",
    );
    assert.equal(
      transitionTask(merging, { type: "merge_blocked" }).failure?.code,
      "branch_protection",
    );
    assert.equal(transitionTask(merging, { type: "merge_timeout" }).failure?.code, "merge_timeout");
    assert.equal(transitionTask(merging, { type: "pr_closed_unmerged" }).failure?.code, "other");

    const branchFailed = transitionTask(cleaning, {
      type: "cleaning_branch_failed",
      message: "denied",
    });
    assert.equal(branchFailed.state, "paused");
    assert.equal(branchFailed.failure?.code, "branch_delete_failed");

    const merged = transitionTask(cleaning, { type: "cleaning_completed" });
    assert.equal(merged.state, "merged");
    assert.equal(merged.cleaning_progress.finalized_done, true);
  });

  it("preserves root failure on paused-to-paused transitions", () => {
    const paused = transitionTask(baseTask("planning", "plan"), {
      type: "pause",
      failure: { phase: "plan", code: "rate_limited", message: "429", ts: "t1" },
    });

    const interrupted = transitionTask(paused, {
      type: "pause",
      failure: { phase: "plan", code: "interrupted", message: "ctrl-c", ts: "t2" },
    });

    assert.equal(interrupted.failure?.code, "rate_limited");
    assert.equal(interrupted.failure_history[0].code, "rate_limited");
    assert.equal(interrupted.failure_history.at(-1)?.code, "interrupted");

    let chain = interrupted;
    for (let i = 0; i < 11; i += 1) {
      chain = transitionTask(chain, {
        type: "pause",
        failure: { phase: "plan", code: "other", message: `next-${i}`, ts: `t${i + 3}` },
      });
    }
    assert.equal(chain.failure_history[0].code, "rate_limited");
    assert.equal(chain.failure_history.length, 10);
    assert.ok(chain.failure_history_truncated_count > 0);
  });

  it("covers explicit fail, resume, retry reset, and runtime phase guards", () => {
    const paused = transitionTask(baseTask("reviewing", "review"), {
      type: "pause",
      failure: { phase: "review", code: "manual_merge_required", message: "manual", ts: "t1" },
    });
    const resumed = transitionTask(paused, { type: "resume" });
    assert.equal(resumed.state, "reviewing");
    assert.equal(resumed.failure, null);
    assert.equal(resumed.failure_history[0].code, "manual_merge_required");

    const failed = transitionTask(baseTask("planning", "plan"), {
      type: "fail",
      failure: { phase: "plan", code: "runner_timeout", message: "timeout", ts: "t2" },
    });
    assert.equal(failed.state, "failed");
    assert.equal(failed.runtime_phase, null);
    assert.ok(failed.failure);

    const reset = transitionTask(
      {
        ...failed,
        failure_history: [failed.failure],
        review_round: 2,
        runtime: {
          ...failed.runtime,
          resolved_effort: {
            phase: "plan",
            provider: "claude",
            effort: "high",
            downgraded_from: null,
            timeout_ms: 3_600_000,
          },
          phase_self_correct_done: true,
          phase_override: {
            phase: "implement",
            provider: "codex",
            effort: "medium",
            expires_at_run_id: "run-1",
          },
        },
      },
      { type: "retry_reset" },
    );
    assert.equal(reset.state, "queued");
    assert.equal(reset.runtime_phase, null);
    assert.equal(reset.failure, null);
    assert.deepEqual(reset.failure_history, []);
    assert.equal(reset.runtime.resolved_effort, null);
    assert.equal(reset.runtime.phase_self_correct_done, null);
    assert.equal(reset.runtime.phase_override, null);

    assert.equal(isAgentRuntimePhase("plan"), true);
    assert.equal(isAgentRuntimePhase("ci_wait"), false);
    assert.equal(isAgentRuntimePhase(null), false);
  });

  it("fails plan verifier at the configured max-round boundary", () => {
    const task = {
      ...baseTask("planning", "plan_verify"),
      plan: { ...baseTask().plan, plan_verify_round: 4 },
    };
    const failed = transitionTask(
      task,
      { type: "plan_verify_rejected" },
      parseConfig({ plan: { max_rounds: 4 } }),
    );

    assert.equal(failed.state, "failed");
    assert.equal(failed.failure?.code, "plan_max");
  });

  it("keeps review-origin fixes on the review path after push", () => {
    const fixing = transitionTask(
      baseTask("reviewing", "supervise"),
      { type: "supervise_accept", origin: "review" },
      DEFAULT_CONFIG,
    );

    const reviewing = transitionTask(fixing, { type: "fix_pushed" }, DEFAULT_CONFIG);

    assert.equal(reviewing.state, "reviewing");
    assert.equal(reviewing.runtime_phase, "review");
    assert.equal(reviewing.fix.origin, null);
    assert.equal(reviewing.ci_fix_round, 0);
  });

  it("clears per-phase checkpoints and sessions when starting new review/fix phases", () => {
    const stale = {
      ...baseTask("ci_waiting", "ci_wait"),
      git: {
        ...baseTask().git,
        checkpoints: {
          ...baseTask().git.checkpoints,
          review: { before_sha: "old-review", after_sha: "old-review-done" },
          supervise: { before_sha: "old-supervise", after_sha: "old-supervise-done" },
          fix: {
            before_sha: "old-before",
            rebase_done: "old-rebase",
            agent_done: "old-agent",
            commit_done: "old-commit",
            push_done: "old-push",
            pr_created: 51,
            head_sha_persisted: "old-head",
            after_sha: "old-after",
          },
        },
      },
      provider_sessions: {
        ...baseTask().provider_sessions,
        review: {
          ...baseTask().provider_sessions.review,
          claude_session_id: "old-review-session",
        },
        supervise: {
          ...baseTask().provider_sessions.supervise,
          claude_session_id: "old-supervise-session",
        },
        fix: { ...baseTask().provider_sessions.fix, codex_session_id: "old-fix-session" },
      },
    };

    const fixing = transitionTask(stale, { type: "ci_failed" }, DEFAULT_CONFIG);
    assert.deepEqual(fixing.git.checkpoints.fix, {
      before_sha: null,
      rebase_done: null,
      agent_done: null,
      commit_done: null,
      push_done: null,
      pr_created: null,
      head_sha_persisted: null,
      after_sha: null,
    });
    assert.equal(fixing.provider_sessions.fix.codex_session_id, null);

    const reviewing = transitionTask(fixing, { type: "fix_pushed" }, DEFAULT_CONFIG);
    assert.deepEqual(reviewing.git.checkpoints.review, { before_sha: null, after_sha: null });
    assert.equal(reviewing.provider_sessions.review.claude_session_id, null);

    const supervising = transitionTask(reviewing, { type: "review_completed" }, DEFAULT_CONFIG);
    assert.deepEqual(supervising.git.checkpoints.supervise, {
      before_sha: null,
      after_sha: null,
    });
    assert.equal(supervising.provider_sessions.supervise.claude_session_id, null);
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

function resolvedModels(): Record<string, string> {
  return {
    plan: "claude:plan",
    plan_verify: "codex:plan_verify",
    plan_fix: "claude:plan_fix",
    implement: "codex:implement",
    review: "claude:review",
    supervise: "claude:supervise",
    fix: "codex:fix",
  };
}
