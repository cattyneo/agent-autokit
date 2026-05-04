import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type AgentRunInput,
  createTaskEntry,
  parseConfig,
  transitionTask,
} from "@cattyneo/autokit-core";

import {
  assignFindingIds,
  computeFindingId,
  type ReviewFinding,
  runPlanningWorkflow,
  runReviewSuperviseWorkflow,
  type WorkflowRunner,
} from "./index.ts";

describe("planning workflow", () => {
  it("orchestrates plan, rejected plan_verify, plan_fix, and accepted plan_verify", async () => {
    const calls: AgentRunInput[] = [];
    const runner = queueRunner(calls, [
      completed("claude", { plan_markdown: "## Plan", assumptions: [], risks: [] }, "plan-session"),
      completed(
        "codex",
        {
          result: "ng",
          findings: [
            {
              severity: "major",
              title: "Missing scope",
              rationale: "The plan should mention workflow boundaries.",
              required_change: "Add non-scope.",
            },
          ],
        },
        "verify-session-1",
      ),
      completed(
        "claude",
        { plan_markdown: "## Fixed Plan", addressed_findings: ["Missing scope"] },
        "fix-session",
      ),
      completed("codex", { result: "ok", findings: [] }, "verify-session-2"),
    ]);

    const result = await runPlanningWorkflow(baseTask(), {
      runner,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
      now: () => "2026-05-05T10:00:00+09:00",
    });

    assert.equal(result.task.state, "planned");
    assert.equal(result.task.runtime_phase, null);
    assert.equal(result.task.plan.state, "verified");
    assert.equal(result.task.plan.plan_verify_round, 1);
    assert.equal(result.planMarkdown, "## Fixed Plan");
    assert.deepEqual(
      calls.map((call) => [call.provider, call.phase, call.promptContract, call.permissions.mode]),
      [
        ["claude", "plan", "plan", "readonly"],
        ["codex", "plan_verify", "plan-verify", "readonly"],
        ["claude", "plan_fix", "plan-fix", "readonly"],
        ["codex", "plan_verify", "plan-verify", "readonly"],
      ],
    );
    assert.equal(calls[0].permissions.workspaceScope, "repo");
    assert.equal(result.task.provider_sessions.plan.claude_session_id, "plan-session");
    assert.equal(result.task.provider_sessions.plan_verify.codex_session_id, "verify-session-2");
  });

  it("pauses on need_input/rate_limited and fails when completed data is missing", async () => {
    const needInput = await runPlanningWorkflow(baseTask(), {
      runner: queueRunner(
        [],
        [
          {
            status: "need_input",
            summary: "question",
            question: { text: "Proceed?", default: "yes" },
          },
        ],
      ),
      repoRoot: "/repo",
      now: () => "2026-05-05T10:00:00+09:00",
    });
    assert.equal(needInput.task.state, "paused");
    assert.equal(needInput.task.failure?.code, "need_input_pending");

    const rateLimited = await runPlanningWorkflow(baseTask(), {
      runner: queueRunner([], [{ status: "rate_limited", summary: "429" }]),
      repoRoot: "/repo",
      now: () => "2026-05-05T10:00:00+09:00",
    });
    assert.equal(rateLimited.task.state, "paused");
    assert.equal(rateLimited.task.failure?.code, "rate_limited");

    const missingData = await runPlanningWorkflow(baseTask(), {
      runner: queueRunner([], [{ status: "completed", summary: "missing data" }]),
      repoRoot: "/repo",
      now: () => "2026-05-05T10:00:00+09:00",
    });
    assert.equal(missingData.task.state, "failed");
    assert.equal(missingData.task.failure?.code, "prompt_contract_violation");
  });
});

describe("review and supervise workflow", () => {
  it("moves accepted findings to fixing without running the fix phase", async () => {
    const calls: AgentRunInput[] = [];
    const finding = reviewFinding();
    const id = computeFindingId(finding);
    const result = await runReviewSuperviseWorkflow(reviewingTask(), {
      runner: queueRunner(calls, [
        completed("claude", { findings: [finding] }, "review-session"),
        completed(
          "claude",
          {
            accept_ids: [id],
            reject_ids: [],
            reject_reasons: {},
            fix_prompt: "Fix the review finding.",
          },
          "supervise-session",
        ),
      ]),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
      now: () => "2026-05-05T10:00:00+09:00",
    });

    assert.equal(result.task.state, "fixing");
    assert.equal(result.task.runtime_phase, "fix");
    assert.equal(result.task.fix.origin, "review");
    assert.equal(result.task.review_round, 1);
    assert.equal(result.task.review_findings[0].round, 1);
    assert.deepEqual(result.task.review_findings[0].accept_ids, [id]);
    assert.equal(result.fixPrompt, "Fix the review finding.");
    assert.deepEqual(
      calls.map((call) => [call.phase, call.permissions.workspaceScope]),
      [
        ["review", "worktree"],
        ["supervise", "worktree"],
      ],
    );
    assert.equal(calls[1].phase, "supervise");
  });

  it("records new rejects once and short-circuits known rejected findings to ci_waiting", async () => {
    const finding = reviewFinding({ title: "Accepted trade-off" });
    const id = computeFindingId(finding);
    const first = await runReviewSuperviseWorkflow(reviewingTask(), {
      runner: queueRunner(
        [],
        [
          completed("claude", { findings: [finding] }),
          completed("claude", {
            accept_ids: [],
            reject_ids: [id],
            reject_reasons: { [id]: "Intentional for MVP." },
          }),
        ],
      ),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(first.task.state, "ci_waiting");
    assert.equal(first.task.runtime_phase, "ci_wait");
    assert.equal(first.task.reject_history.length, 1);
    assert.equal(first.task.reject_history[0].finding_id, id);
    assert.equal(first.task.review_findings[0].reject_reasons[id], "Intentional for MVP.");

    const secondInput = {
      ...first.task,
      state: "reviewing" as const,
      runtime_phase: "review" as const,
    };
    const calls: AgentRunInput[] = [];
    const second = await runReviewSuperviseWorkflow(secondInput, {
      runner: queueRunner(calls, [completed("claude", { findings: [finding] })]),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(second.task.state, "ci_waiting");
    assert.equal(second.task.reject_history.length, 1);
    assert.deepEqual(
      calls.map((call) => call.phase),
      ["review"],
    );
  });

  it("fails invalid supervisor ids and review_max boundaries", async () => {
    const finding = reviewFinding();
    const id = computeFindingId(finding);
    const invalid = await runReviewSuperviseWorkflow(reviewingTask(), {
      runner: queueRunner(
        [],
        [
          completed("claude", { findings: [finding] }),
          completed("claude", {
            accept_ids: ["unknown"],
            reject_ids: [id],
            reject_reasons: { [id]: "reject" },
            fix_prompt: "Fix unknown.",
          }),
        ],
      ),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
      now: () => "2026-05-05T10:00:00+09:00",
    });
    assert.equal(invalid.task.state, "failed");
    assert.equal(invalid.task.failure?.code, "prompt_contract_violation");

    const maxed = await runReviewSuperviseWorkflow(
      { ...reviewingTask(), review_round: 3 },
      {
        runner: queueRunner(
          [],
          [
            completed("claude", { findings: [finding] }),
            completed("claude", {
              accept_ids: [id],
              reject_ids: [],
              reject_reasons: {},
              fix_prompt: "Fix.",
            }),
          ],
        ),
        repoRoot: "/repo",
        worktreeRoot: "/worktree",
        config: parseConfig({ review: { max_rounds: 3 } }),
      },
    );
    assert.equal(maxed.task.state, "failed");
    assert.equal(maxed.task.failure?.code, "review_max");
  });

  it("uses deterministic finding ids from normalized file and title", () => {
    const finding = reviewFinding({
      file: "./packages\\core/src/index.ts",
      title: "  Contract   issue ",
    });
    const assigned = assignFindingIds([finding]);

    assert.equal(assigned[0].file, "packages/core/src/index.ts");
    assert.equal(assigned[0].title, "Contract issue");
    assert.equal(assigned[0].finding_id, computeFindingId(finding));
    assert.equal(assigned[0].finding_id.length, 16);
  });
});

function baseTask() {
  return createTaskEntry({
    issue: 12,
    slug: "ak-011",
    title: "AK-011",
    labels: ["agent-ready"],
    now: "2026-05-05T09:00:00+09:00",
  });
}

function reviewingTask() {
  return transitionTask(
    {
      ...baseTask(),
      state: "implementing",
      runtime_phase: "implement",
    },
    { type: "pr_ready", headSha: "head-sha", prNumber: 12, baseSha: "base-sha" },
  );
}

function reviewFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "P1",
    file: "packages/core/src/index.ts",
    line: 12,
    title: "Contract issue",
    rationale: "The workflow must preserve the review contract.",
    suggested_fix: "Record the finding decision.",
    ...overrides,
  };
}

function completed(
  provider: "claude" | "codex",
  structured: Record<string, unknown>,
  sessionId?: string,
) {
  return {
    status: "completed" as const,
    summary: "ok",
    structured,
    session: provider === "claude" ? { claudeSessionId: sessionId } : { codexSessionId: sessionId },
  };
}

function queueRunner(
  calls: AgentRunInput[],
  outputs: Awaited<ReturnType<WorkflowRunner>>[],
): WorkflowRunner {
  return async (input) => {
    calls.push(input);
    const output = outputs.shift();
    if (output === undefined) {
      throw new Error(`unexpected runner call for ${input.phase}`);
    }
    return output;
  };
}
