import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type AgentRunInput,
  createTaskEntry,
  parseConfig,
  type TaskEntry,
  transitionTask,
} from "@cattyneo/autokit-core";

import {
  assignFindingIds,
  type BranchPrLookup,
  type CiCheckObservation,
  type CiWaitDeps,
  type CiWaitPrObservation,
  type CleaningDeps,
  computeFindingId,
  type ImplementFixGitDeps,
  type MergeDeps,
  type MergePrObservation,
  type ReviewFinding,
  runCiWaitWorkflow,
  runCleaningWorkflow,
  runFixWorkflow,
  runImplementWorkflow,
  runMergeWorkflow,
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
    assert.deepEqual(calls[0].effort, {
      phase: "plan",
      provider: "claude",
      effort: "medium",
      downgraded_from: null,
      timeout_ms: 1_800_000,
    });
    assert.deepEqual(calls[0].effective_permission, {
      permission_profile: "readonly_repo",
      claude: {
        allowed_tools: ["Read", "Grep", "Glob"],
        denied_tools: ["Bash", "Edit", "Write", "WebFetch", "WebSearch"],
        hook: "readonly_path_guard",
      },
    });
    assert.equal(result.task.provider_sessions.plan.claude_session_id, "plan-session");
    assert.equal(result.task.provider_sessions.plan_verify.codex_session_id, "verify-session-2");
  });

  it("applies deprecated Claude allowed_tools as a read-only shrink cap", async () => {
    const calls: AgentRunInput[] = [];

    await runPlanningWorkflow(baseTask(), {
      runner: queueRunner(calls, [
        completed("claude", { plan_markdown: "## Plan", assumptions: [], risks: [] }),
        completed("codex", { result: "ok", findings: [] }),
      ]),
      repoRoot: "/repo",
      config: parseConfig({
        permissions: { claude: { allowed_tools: ["Read"] } },
      }),
    });

    assert.deepEqual(calls[0].effective_permission?.claude, {
      allowed_tools: ["Read"],
      denied_tools: ["Bash", "Edit", "Write", "WebFetch", "WebSearch", "Grep", "Glob"],
      hook: "readonly_path_guard",
    });
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
    assert.match(needInput.task.failure?.message ?? "", /default: yes/);

    const rateLimited = await runPlanningWorkflow(baseTask(), {
      runner: queueRunner([], [{ status: "rate_limited", summary: "429" }]),
      repoRoot: "/repo",
      now: () => "2026-05-05T10:00:00+09:00",
    });
    assert.equal(rateLimited.task.state, "paused");
    assert.equal(rateLimited.task.failure?.code, "rate_limited");

    const missingData = await runPlanningWorkflow(baseTask(), {
      runner: queueRunner(
        [],
        [
          { status: "completed", summary: "missing data" },
          { status: "completed", summary: "still missing data" },
        ],
      ),
      repoRoot: "/repo",
      now: () => "2026-05-05T10:00:00+09:00",
    });
    assert.equal(missingData.task.state, "failed");
    assert.equal(missingData.task.failure?.code, "prompt_contract_violation");
  });

  it("self-corrects one prompt contract runner error before retrying the same phase", async () => {
    const calls: AgentRunInput[] = [];
    const audits: Array<Record<string, unknown>> = [];
    const persisted: Array<boolean | null> = [];
    const events: string[] = [];
    let invocation = 0;

    const result = await runPlanningWorkflow(baseTask(), {
      runner: async (input) => {
        calls.push(input);
        events.push(`runner:${input.phase}`);
        invocation += 1;
        if (invocation === 1) {
          throw Object.assign(new Error("bad schema"), { code: "prompt_contract_violation" });
        }
        if (input.phase === "plan") {
          return completed("claude", { plan_markdown: "## Plan", assumptions: [], risks: [] });
        }
        return completed("codex", { result: "ok", findings: [] });
      },
      repoRoot: "/repo/root",
      homeDir: "/Users/tester",
      auditOperation: (kind, fields) => {
        events.push(`audit:${kind}`);
        audits.push({ kind, ...fields });
      },
      persistTask: (task) => {
        if (task.runtime.phase_self_correct_done === true) {
          events.push("persist:self-correct");
        }
        persisted.push(task.runtime.phase_self_correct_done);
      },
      now: () => "2026-05-05T10:00:00+09:00",
    });

    assert.equal(result.task.state, "planned");
    assert.deepEqual(
      calls.map((call) => call.phase),
      ["plan", "plan", "plan_verify"],
    );
    assert.equal(audits[0].kind, "phase_self_correct");
    assert.equal(audits[0].phase, "plan");
    assert.deepEqual(persisted.slice(0, 2), [false, true]);
    assert.deepEqual(events.slice(0, 4), [
      "runner:plan",
      "persist:self-correct",
      "audit:phase_self_correct",
      "runner:plan",
    ]);
  });

  it("fails the second prompt contract violation after self-correction was already persisted", async () => {
    const task = {
      ...baseTask(),
      state: "planning" as const,
      runtime_phase: "plan" as const,
      runtime: { ...baseTask().runtime, phase_self_correct_done: true },
    };
    const audits: Array<Record<string, unknown>> = [];

    const result = await runPlanningWorkflow(task, {
      runner: async () => {
        throw Object.assign(new Error("bad schema again"), {
          code: "prompt_contract_violation",
        });
      },
      repoRoot: "/repo",
      auditOperation: (kind, fields) => audits.push({ kind, ...fields }),
    });

    assert.equal(result.task.state, "failed");
    assert.equal(result.task.failure?.code, "prompt_contract_violation");
    assert.equal(result.task.failure?.message, "bad schema again");
    assert.equal(audits.length, 0);
  });

  it("self-corrects missing structured data once before enforcing the prompt contract", async () => {
    const calls: AgentRunInput[] = [];
    const audits: Array<Record<string, unknown>> = [];

    const result = await runPlanningWorkflow(baseTask(), {
      runner: queueRunner(calls, [
        { status: "completed", summary: "missing data" },
        completed("claude", { plan_markdown: "## Plan", assumptions: [], risks: [] }),
        completed("codex", { result: "ok", findings: [] }),
      ]),
      repoRoot: "/repo",
      auditOperation: (kind, fields) => audits.push({ kind, ...fields }),
    });

    assert.equal(result.task.state, "planned");
    assert.deepEqual(
      calls.map((call) => call.phase),
      ["plan", "plan", "plan_verify"],
    );
    assert.equal(audits[0].kind, "phase_self_correct");
    assert.equal(audits[0].phase, "plan");
  });

  it("self-corrects Codex plan_verify contract errors before retrying the same phase", async () => {
    const calls: AgentRunInput[] = [];
    let planVerifyInvocation = 0;

    const result = await runPlanningWorkflow(baseTask(), {
      runner: async (input) => {
        calls.push(input);
        if (input.phase === "plan") {
          return completed("claude", { plan_markdown: "## Plan", assumptions: [], risks: [] });
        }
        planVerifyInvocation += 1;
        if (planVerifyInvocation === 1) {
          throw Object.assign(new Error("codex contract drift"), {
            code: "prompt_contract_violation",
          });
        }
        return completed("codex", { result: "ok", findings: [] });
      },
      repoRoot: "/repo",
    });

    assert.equal(result.task.state, "planned");
    assert.deepEqual(
      calls.map((call) => `${call.provider}:${call.phase}`),
      ["claude:plan", "codex:plan_verify", "codex:plan_verify"],
    );
  });

  it("answers need_input with default and resumes the same runner phase", async () => {
    const calls: AgentRunInput[] = [];
    const result = await runPlanningWorkflow(baseTask(), {
      runner: queueRunner(calls, [
        {
          status: "need_input",
          summary: "question",
          question: { text: "Use vitest?", default: "vitest" },
          session: { claudeSessionId: "plan-session" },
        },
        completed("claude", { plan_markdown: "## Plan", assumptions: [], risks: [] }),
        completed("codex", { result: "ok", findings: [] }),
      ]),
      answerQuestion: ({ question }) => question.default,
      repoRoot: "/repo",
      now: () => "2026-05-05T10:00:00+09:00",
    });

    assert.equal(result.task.state, "planned");
    assert.equal(calls[1].phase, "plan");
    assert.equal(calls[1].resume?.claudeSessionId, "plan-session");
    assert.deepEqual(calls[1].questionResponse, {
      text: "Use vitest?",
      default: "vitest",
      answer: "vitest",
    });
    assert.doesNotMatch(calls[1].prompt, /Autokit need_input response:/);
    assert.doesNotMatch(calls[1].prompt, /answer: vitest/);
  });

  it("persists configured models before runner dispatch and reuses them after resume", async () => {
    const calls: AgentRunInput[] = [];
    const first = await runPlanningWorkflow(baseTask(), {
      runner: queueRunner(calls, [
        {
          status: "need_input",
          summary: "question",
          question: { text: "Proceed?", default: "yes" },
        },
      ]),
      repoRoot: "/repo",
      config: parseConfig({ phases: { plan: { model: "model-a" } } }),
      now: () => "2026-05-05T10:00:00+09:00",
    });

    assert.equal(first.task.state, "paused");
    assert.equal(first.task.runtime.resolved_model.plan, "model-a");
    const resumed = transitionTask(first.task, { type: "resume" });

    const second = await runPlanningWorkflow(resumed, {
      runner: queueRunner(calls, [
        completed("claude", { plan_markdown: "## Plan", assumptions: [], risks: [] }),
        completed("codex", { result: "ok", findings: [] }),
      ]),
      repoRoot: "/repo",
      config: parseConfig({ phases: { plan: { model: "model-b" } } }),
      now: () => "2026-05-05T10:01:00+09:00",
    });

    assert.equal(second.task.state, "planned");
    assert.equal(calls[0].model, "model-a");
    assert.equal(calls[1].model, "model-a");
    assert.equal(calls[2].model, "auto");
  });

  it("records interrupted_at and previous state when a need_input prompt is interrupted", async () => {
    const result = await runPlanningWorkflow(baseTask(), {
      runner: queueRunner(
        [],
        [
          {
            status: "need_input",
            summary: "question",
            question: { text: "Use vitest?", default: "vitest" },
          },
        ],
      ),
      answerQuestion: () => {
        throw Object.assign(new Error("ctrl-c"), { code: "interrupted" });
      },
      repoRoot: "/repo",
      now: () => "2026-05-05T10:00:00+09:00",
    });

    assert.equal(result.task.state, "paused");
    assert.equal(result.task.failure?.code, "interrupted");
    assert.equal(result.task.runtime.previous_state, "planning");
    assert.equal(result.task.runtime.interrupted_at, "2026-05-05T10:00:00+09:00");
  });

  it("converts runner FailureCode exceptions into task state", async () => {
    const promptContractFailure = await runPlanningWorkflow(
      {
        ...baseTask(),
        state: "planning",
        runtime_phase: "plan",
        runtime: { ...baseTask().runtime, phase_self_correct_done: true },
      },
      {
        runner: async () => {
          throw Object.assign(new Error("bad schema"), { code: "prompt_contract_violation" });
        },
        repoRoot: "/repo",
        now: () => "2026-05-05T10:00:00+09:00",
      },
    );

    assert.equal(promptContractFailure.task.state, "failed");
    assert.equal(promptContractFailure.task.failure?.code, "prompt_contract_violation");

    const sandboxFailure = await runPlanningWorkflow(baseTask(), {
      runner: async () => {
        throw Object.assign(new Error("outside write"), { code: "sandbox_violation" });
      },
      repoRoot: "/repo",
      now: () => "2026-05-05T10:00:00+09:00",
    });

    assert.equal(sandboxFailure.task.state, "paused");
    assert.equal(sandboxFailure.task.failure?.code, "sandbox_violation");
  });

  it("redacts runner summaries in failure messages and history", async () => {
    const result = await runPlanningWorkflow(baseTask(), {
      runner: queueRunner(
        [],
        [
          {
            status: "rate_limited",
            summary: `429 sk-${"a".repeat(24)} /Users/tester/.env:4 SECRET=raw-secret /repo/root`,
          },
        ],
      ),
      repoRoot: "/repo/root",
      homeDir: "/Users/tester",
      now: () => "2026-05-05T10:00:00+09:00",
    });

    assert.equal(result.task.state, "paused");
    assert.equal(result.task.failure?.code, "rate_limited");
    assert.doesNotMatch(
      result.task.failure?.message ?? "",
      /sk-|\/Users\/tester|\/repo\/root|raw-secret/,
    );
    assert.equal(result.task.failure_history.length, 1);
    assert.equal(result.task.failure_history[0].message, result.task.failure?.message);
  });
});

describe("implement and fix workflow", () => {
  it("fails or downgrades unsupported effort at workflow boundary", async () => {
    const unsupportedConfig = parseConfig({
      effort: { unsupported_policy: "fail" },
      phases: { implement: { provider: "codex", effort: "high", model: "gpt-5.4-mini" } },
    });
    const failed = await runImplementWorkflow(implementReadyTask(), {
      runner: queueRunner([], []),
      git: mockGitDeps(["base-sha"], []),
      repoRoot: "/repo/root",
      worktreeRoot: "/repo/root/.autokit/worktrees/issue-13",
      homeDir: "/Users/tester",
      config: unsupportedConfig,
      now: () => "2026-05-05T10:00:00+09:00",
    });

    assert.equal(failed.task.state, "failed");
    assert.equal(failed.task.failure?.code, "effort_unsupported");
    assert.match(
      failed.task.failure?.message ?? "",
      /effort=high provider=codex model=gpt-5.4-mini/,
    );
    assert.doesNotMatch(failed.task.failure?.message ?? "", /\/Users\/tester|\/repo\/root/);

    const calls: AgentRunInput[] = [];
    const audits: Array<Record<string, unknown>> = [];
    const downgraded = await runImplementWorkflow(implementReadyTask(), {
      runner: queueRunner(calls, [
        completed("codex", {
          changed_files: [],
          tests_run: [],
          docs_updated: false,
          notes: "ok",
        }),
      ]),
      git: mockGitDeps(["base-sha", "agent-sha"], ["commit-sha"], {
        prNumber: 51,
        prHeadSha: "remote-head",
      }),
      repoRoot: "/repo/root",
      worktreeRoot: "/repo/root/.autokit/worktrees/issue-13",
      homeDir: "/Users/tester",
      config: parseConfig({
        effort: { unsupported_policy: "downgrade" },
        phases: {
          implement: {
            provider: "codex",
            effort: "high",
            model: `/Users/tester/gpt-5.4-mini-sk-${"a".repeat(24)}`,
          },
        },
        runner_timeout: { implement_ms: 900_000 },
      }),
      auditOperation: (kind, fields) => audits.push({ kind, ...fields }),
    });

    assert.equal(downgraded.task.runtime.resolved_effort?.effort, "medium");
    assert.equal(downgraded.task.runtime.resolved_effort?.downgraded_from, "high");
    assert.equal(calls[0].effort?.effort, "medium");
    assert.equal(calls[0].effort?.timeout_ms, 900_000);
    assert.equal(calls[0].timeoutMs, 900_000);
    assert.equal(audits[0].kind, "effort_downgrade");
    assert.equal(audits[0].from, "high");
    assert.equal(audits[0].to, "medium");
    assert.doesNotMatch(String(audits[0].model), /\/Users\/tester|sk-/);

    const noExplicitCalls: AgentRunInput[] = [];
    const downgradedNoExplicit = await runImplementWorkflow(implementReadyTask(), {
      runner: queueRunner(noExplicitCalls, [
        completed("codex", {
          changed_files: [],
          tests_run: [],
          docs_updated: false,
          notes: "ok",
        }),
      ]),
      git: mockGitDeps(["base-sha", "agent-sha"], ["commit-sha"], {
        prNumber: 51,
        prHeadSha: "remote-head",
      }),
      repoRoot: "/repo/root",
      worktreeRoot: "/repo/root/.autokit/worktrees/issue-13",
      config: parseConfig({
        effort: { unsupported_policy: "downgrade" },
        phases: { implement: { provider: "codex", effort: "high", model: "gpt-5.4-mini" } },
      }),
    });

    assert.equal(downgradedNoExplicit.task.runtime.resolved_effort?.effort, "medium");
    assert.equal(downgradedNoExplicit.task.runtime.resolved_effort?.timeout_ms, 1_800_000);
    assert.equal(noExplicitCalls[0].timeoutMs, 1_800_000);
  });

  it("runs implement through ordered checkpoints and opens a ready PR", async () => {
    const calls: AgentRunInput[] = [];
    const persisted: string[] = [];
    const git = mockGitDeps(["base-sha", "agent-sha"], ["commit-sha"], {
      prNumber: 51,
      prHeadSha: "remote-head",
      baseSha: "base-sha",
    });
    const task = {
      ...baseTask(),
      state: "planned" as const,
      runtime_phase: null,
      branch: "autokit/issue-13",
      worktree_path: ".autokit/worktrees/issue-13",
      plan: { ...baseTask().plan, state: "verified" as const },
    };

    const result = await runImplementWorkflow(task, {
      runner: queueRunner(calls, [
        completed(
          "codex",
          {
            changed_files: ["packages/workflows/src/index.ts"],
            tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
            docs_updated: false,
            notes: "implemented",
          },
          "codex-implement-session",
        ),
      ]),
      git,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
      persistTask: (next) => {
        persisted.push(implementCheckpointState(next));
      },
      now: () => "2026-05-05T10:00:00+09:00",
    });

    assert.equal(result.task.state, "reviewing");
    assert.equal(result.task.runtime_phase, "review");
    assert.equal(result.task.pr.number, 51);
    assert.equal(result.task.pr.head_sha, "remote-head");
    assert.equal(result.task.git.checkpoints.implement.before_sha, "base-sha");
    assert.equal(result.task.git.checkpoints.implement.agent_done, "agent-sha");
    assert.equal(result.task.git.checkpoints.implement.commit_done, "commit-sha");
    assert.equal(result.task.git.checkpoints.implement.push_done, "commit-sha");
    assert.equal(result.task.git.checkpoints.implement.pr_created, 51);
    assert.equal(result.task.git.checkpoints.implement.head_sha_persisted, "remote-head");
    assert.equal(result.task.git.checkpoints.implement.after_sha, "remote-head");
    assert.equal(
      result.task.provider_sessions.implement.codex_session_id,
      "codex-implement-session",
    );
    assert.deepEqual(
      calls.map((call) => [
        call.provider,
        call.phase,
        call.permissions.mode,
        call.permissions.workspaceScope,
      ]),
      [["codex", "implement", "workspace-write", "worktree"]],
    );
    assert.deepEqual(git.calls, [
      "getHeadSha",
      "getHeadSha",
      "stageAll",
      "commit:Implement issue #13",
      "push:autokit/issue-13",
      "createDraftPr:commit-sha",
      "getPrHead:51",
      "markPrReady:51",
    ]);
    assert.deepEqual(persisted, [
      "before=base-sha agent=null commit=null push=null pr=null head=null after=null",
      "before=base-sha agent=null commit=null push=null pr=null head=null after=null",
      "before=base-sha agent=agent-sha commit=null push=null pr=null head=null after=null",
      "before=base-sha agent=agent-sha commit=commit-sha push=null pr=null head=null after=null",
      "before=base-sha agent=agent-sha commit=commit-sha push=commit-sha pr=null head=null after=null",
      "before=base-sha agent=agent-sha commit=commit-sha push=commit-sha pr=51 head=null after=null",
      "before=base-sha agent=agent-sha commit=commit-sha push=commit-sha pr=51 head=remote-head after=null",
      "before=base-sha agent=agent-sha commit=commit-sha push=commit-sha pr=51 head=remote-head after=remote-head",
    ]);
  });

  it("fails cold restart before rerunning the same phase for the third time", async () => {
    const calls: AgentRunInput[] = [];
    const task = {
      ...implementReadyTask(),
      state: "implementing" as const,
      runtime_phase: "implement" as const,
      runtime: { ...baseTask().runtime, phase_attempt: 2 },
      git: {
        ...baseTask().git,
        base_sha: "base-sha",
        checkpoints: {
          ...baseTask().git.checkpoints,
          implement: { ...baseTask().git.checkpoints.implement, before_sha: "base-sha" },
        },
      },
    };

    const result = await runImplementWorkflow(task, {
      runner: queueRunner(calls, [
        completed("codex", {
          changed_files: [],
          tests_run: [],
          docs_updated: false,
          notes: "should not run",
        }),
      ]),
      git: mockGitDeps([], []),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(result.task.state, "failed");
    assert.equal(result.task.failure?.code, "phase_attempt_exceeded");
    assert.equal(calls.length, 0);
  });

  it("increments cold restart attempts before runner execution and resets after success", async () => {
    const calls: AgentRunInput[] = [];
    const persisted: number[] = [];
    const task = {
      ...implementReadyTask(),
      state: "implementing" as const,
      runtime_phase: "implement" as const,
      runtime: { ...baseTask().runtime, phase_attempt: 1 },
      git: {
        ...baseTask().git,
        base_sha: "base-sha",
        checkpoints: {
          ...baseTask().git.checkpoints,
          implement: { ...baseTask().git.checkpoints.implement, before_sha: "base-sha" },
        },
      },
    };

    const result = await runImplementWorkflow(task, {
      runner: queueRunner(calls, [
        completed("codex", {
          changed_files: [],
          tests_run: [],
          docs_updated: false,
          notes: "ok",
        }),
      ]),
      git: mockGitDeps(["agent-sha"], ["commit-sha"], {
        prNumber: 51,
        prHeadSha: "remote-head",
      }),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
      persistTask: (next) => {
        persisted.push(next.runtime.phase_attempt);
      },
    });

    assert.equal(result.task.state, "reviewing");
    assert.equal(result.task.runtime.phase_attempt, 0);
    assert.ok(persisted.includes(2));
    assert.ok(persisted.includes(0));
    assert.equal(calls.length, 1);
  });

  it("resets phase attempts after a resumed session returns runner output", async () => {
    const calls: AgentRunInput[] = [];
    const task = {
      ...baseTask(),
      state: "implementing" as const,
      runtime_phase: "implement" as const,
      runtime: { ...baseTask().runtime, phase_attempt: 2 },
      branch: "autokit/issue-13",
      worktree_path: ".autokit/worktrees/issue-13",
      git: {
        ...baseTask().git,
        base_sha: "base-sha",
        checkpoints: {
          ...baseTask().git.checkpoints,
          implement: { ...baseTask().git.checkpoints.implement, before_sha: "base-sha" },
        },
      },
      provider_sessions: {
        ...baseTask().provider_sessions,
        implement: {
          ...baseTask().provider_sessions.implement,
          codex_session_id: "codex-implement-session",
        },
      },
    };

    const result = await runImplementWorkflow(task, {
      runner: queueRunner(calls, [
        completed("codex", {
          changed_files: [],
          tests_run: [],
          docs_updated: false,
          notes: "resumed",
        }),
      ]),
      git: mockGitDeps(["agent-sha"], ["commit-sha"], {
        prNumber: 51,
        prHeadSha: "remote-head",
      }),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(result.task.state, "reviewing");
    assert.equal(result.task.runtime.phase_attempt, 0);
    assert.deepEqual(calls[0].resume, { codexSessionId: "codex-implement-session" });
  });

  it("fails review cold restart before rerunning the same phase for the third time", async () => {
    const calls: AgentRunInput[] = [];
    const task = {
      ...reviewingTask(),
      runtime: { ...reviewingTask().runtime, phase_attempt: 2 },
      git: {
        ...reviewingTask().git,
        checkpoints: {
          ...reviewingTask().git.checkpoints,
          review: { before_sha: "head-sha", after_sha: null },
        },
      },
    };

    const result = await runReviewSuperviseWorkflow(task, {
      runner: queueRunner(calls, [completed("claude", { findings: [] })]),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(result.task.state, "failed");
    assert.equal(result.task.failure?.code, "phase_attempt_exceeded");
    assert.equal(calls.length, 0);
  });

  it("resumes Codex sessions for crashed implement phases", async () => {
    const calls: AgentRunInput[] = [];
    const git = mockGitDeps(["agent-sha"], ["commit-sha"], {
      prNumber: 51,
      prHeadSha: "remote-head",
      baseSha: "base-sha",
    });
    const task = {
      ...baseTask(),
      state: "implementing" as const,
      runtime_phase: "implement" as const,
      branch: "autokit/issue-13",
      worktree_path: ".autokit/worktrees/issue-13",
      git: {
        ...baseTask().git,
        base_sha: "base-sha",
        checkpoints: {
          ...baseTask().git.checkpoints,
          implement: { ...baseTask().git.checkpoints.implement, before_sha: "base-sha" },
        },
      },
      provider_sessions: {
        ...baseTask().provider_sessions,
        implement: {
          ...baseTask().provider_sessions.implement,
          codex_session_id: "codex-implement-session",
        },
      },
    };

    await runImplementWorkflow(task, {
      runner: queueRunner(calls, [
        completed("codex", {
          changed_files: ["packages/workflows/src/index.ts"],
          tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
          docs_updated: false,
          notes: "implemented",
        }),
      ]),
      git,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.deepEqual(calls[0].resume, { codexSessionId: "codex-implement-session" });
  });

  it("resumes reverse-provider sessions using last_provider and preserves opposite session ids", async () => {
    const calls: AgentRunInput[] = [];
    const task = {
      ...baseTask(),
      state: "planning" as const,
      runtime_phase: "plan" as const,
      git: {
        ...baseTask().git,
        checkpoints: {
          ...baseTask().git.checkpoints,
          plan: { ...baseTask().git.checkpoints.plan, before_sha: "before" },
        },
      },
      provider_sessions: {
        ...baseTask().provider_sessions,
        plan: {
          claude_session_id: "claude-plan-old",
          codex_session_id: "codex-plan",
          last_provider: "codex" as const,
        },
      },
    };

    const result = await runPlanningWorkflow(task, {
      runner: queueRunner(calls, [
        completed(
          "codex",
          { plan_markdown: "## Plan", assumptions: [], risks: [] },
          "codex-plan-new",
        ),
        completed("codex", { result: "ok", findings: [] }),
      ]),
      repoRoot: "/repo",
    });

    assert.equal(calls[0].provider, "codex");
    assert.deepEqual(calls[0].resume, { codexSessionId: "codex-plan" });
    assert.equal(result.task.provider_sessions.plan.codex_session_id, "codex-plan-new");
    assert.equal(result.task.provider_sessions.plan.claude_session_id, "claude-plan-old");
    assert.equal(result.task.provider_sessions.plan.last_provider, "codex");
  });

  it("uses phase_override provider before last_provider and config provider", async () => {
    const calls: AgentRunInput[] = [];
    const task = {
      ...baseTask(),
      state: "planning" as const,
      runtime_phase: "plan" as const,
      runtime: {
        ...baseTask().runtime,
        phase_override: {
          phase: "plan" as const,
          provider: "claude" as const,
          effort: "low" as const,
          expires_at_run_id: "run-1",
        },
      },
      git: {
        ...baseTask().git,
        checkpoints: {
          ...baseTask().git.checkpoints,
          plan: { ...baseTask().git.checkpoints.plan, before_sha: "before" },
        },
      },
      provider_sessions: {
        ...baseTask().provider_sessions,
        plan: {
          claude_session_id: "claude-plan",
          codex_session_id: "codex-plan",
          last_provider: "codex" as const,
        },
      },
    };

    await runPlanningWorkflow(task, {
      runner: queueRunner(calls, [
        completed("claude", { plan_markdown: "## Plan", assumptions: [], risks: [] }),
        completed("codex", { result: "ok", findings: [] }),
      ]),
      repoRoot: "/repo",
      config: parseConfig({
        phases: { plan: { provider: "codex", effort: "high", model: "gpt-5.5" } },
      }),
    });

    assert.equal(calls[0].provider, "claude");
    assert.deepEqual(calls[0].resume, { claudeSessionId: "claude-plan" });
    assert.equal(calls[0].effort?.effort, "low");
    assert.deepEqual(calls[0].effective_permission, {
      permission_profile: "readonly_repo",
      claude: {
        allowed_tools: ["Read", "Grep", "Glob"],
        denied_tools: ["Bash", "Edit", "Write", "WebFetch", "WebSearch"],
        hook: "readonly_path_guard",
      },
    });
  });

  it("continues implement from commit_done without rerunning the agent", async () => {
    const calls: AgentRunInput[] = [];
    const git = mockGitDeps([], [], {
      prNumber: 51,
      prHeadSha: "remote-head",
      baseSha: "base-sha",
    });
    const task = {
      ...baseTask(),
      state: "implementing" as const,
      runtime_phase: "implement" as const,
      branch: "autokit/issue-13",
      worktree_path: ".autokit/worktrees/issue-13",
      git: {
        ...baseTask().git,
        base_sha: "base-sha",
        checkpoints: {
          ...baseTask().git.checkpoints,
          implement: {
            ...baseTask().git.checkpoints.implement,
            before_sha: "base-sha",
            agent_done: "agent-sha",
            commit_done: "commit-sha",
          },
        },
      },
    };

    const result = await runImplementWorkflow(task, {
      runner: queueRunner(calls, []),
      git,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(result.task.state, "reviewing");
    assert.equal(calls.length, 0);
    assert.deepEqual(git.calls, [
      "push:autokit/issue-13",
      "createDraftPr:commit-sha",
      "getPrHead:51",
      "markPrReady:51",
    ]);
  });

  it("restores an existing branch PR after implement push_done", async () => {
    const calls: AgentRunInput[] = [];
    const git = mockGitDeps([], [], {
      prHeadSha: "remote-head",
      baseSha: "base-sha",
      branchPr: { state: "OPEN", number: 88, headSha: "remote-head", baseSha: "base-sha" },
    });
    const task = {
      ...baseTask(),
      state: "implementing" as const,
      runtime_phase: "implement" as const,
      branch: "autokit/issue-13",
      worktree_path: ".autokit/worktrees/issue-13",
      git: {
        ...baseTask().git,
        base_sha: "base-sha",
        checkpoints: {
          ...baseTask().git.checkpoints,
          implement: {
            ...baseTask().git.checkpoints.implement,
            before_sha: "base-sha",
            agent_done: "agent-sha",
            commit_done: "commit-sha",
            push_done: "commit-sha",
          },
        },
      },
    };

    const result = await runImplementWorkflow(task, {
      runner: queueRunner(calls, []),
      git,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(result.task.pr.number, 88);
    assert.equal(result.task.state, "reviewing");
    assert.equal(calls.length, 0);
    assert.deepEqual(git.calls, [
      "findPrForBranch:autokit/issue-13",
      "getPrHead:88",
      "markPrReady:88",
    ]);
  });

  it("runs review-origin fix through rebase and returns to review", async () => {
    const calls: AgentRunInput[] = [];
    const git = mockGitDeps(["before-fix", "rebase-sha", "agent-fix-sha"], ["fix-commit"], {
      prHeadSha: "fix-head",
      baseSha: "base-sha",
    });

    const result = await runFixWorkflow(fixingTask("review"), {
      runner: queueRunner(calls, [
        completed(
          "codex",
          {
            changed_files: ["packages/workflows/src/index.ts"],
            tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
            resolved_accept_ids: ["finding-1"],
            unresolved_accept_ids: [],
            notes: "fixed",
          },
          "codex-fix-session",
        ),
      ]),
      git,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(result.task.state, "reviewing");
    assert.equal(result.task.runtime_phase, "review");
    assert.equal(result.task.fix.origin, null);
    assert.equal(result.task.ci_fix_round, 0);
    assert.equal(result.task.git.checkpoints.fix.before_sha, "before-fix");
    assert.equal(result.task.git.checkpoints.fix.rebase_done, "rebase-sha");
    assert.equal(result.task.git.checkpoints.fix.agent_done, "agent-fix-sha");
    assert.equal(result.task.git.checkpoints.fix.commit_done, "fix-commit");
    assert.equal(result.task.git.checkpoints.fix.push_done, "fix-commit");
    assert.equal(result.task.git.checkpoints.fix.head_sha_persisted, "fix-head");
    assert.equal(result.task.git.checkpoints.fix.after_sha, "fix-head");
    assert.equal(result.task.provider_sessions.fix.codex_session_id, "codex-fix-session");
    assert.deepEqual(
      calls.map((call) => [
        call.provider,
        call.phase,
        call.permissions.mode,
        call.permissions.workspaceScope,
      ]),
      [["codex", "fix", "workspace-write", "worktree"]],
    );
    assert.deepEqual(git.calls, [
      "getHeadSha",
      "rebase",
      "getHeadSha",
      "getHeadSha",
      "stageAll",
      "commit:Fix issue #13",
      "push:autokit/issue-13",
      "getPrHead:51",
    ]);
  });

  it("resumes Codex sessions for crashed fix phases after rebase", async () => {
    const calls: AgentRunInput[] = [];
    const git = mockGitDeps(["agent-fix-sha"], ["fix-commit"], {
      prHeadSha: "fix-head",
      baseSha: "base-sha",
    });
    const task = {
      ...fixingTask("review"),
      git: {
        ...baseTask().git,
        checkpoints: {
          ...baseTask().git.checkpoints,
          fix: {
            ...baseTask().git.checkpoints.fix,
            before_sha: "before-fix",
            rebase_done: "rebase-sha",
          },
        },
      },
      provider_sessions: {
        ...baseTask().provider_sessions,
        fix: { ...baseTask().provider_sessions.fix, codex_session_id: "codex-fix-session" },
      },
    };

    await runFixWorkflow(task, {
      runner: queueRunner(calls, [
        completed("codex", {
          changed_files: ["packages/workflows/src/index.ts"],
          tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
          resolved_accept_ids: ["finding-1"],
          unresolved_accept_ids: [],
          notes: "fixed",
        }),
      ]),
      git,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.deepEqual(calls[0].resume, { codexSessionId: "codex-fix-session" });
    assert.deepEqual(git.calls, [
      "getHeadSha",
      "stageAll",
      "commit:Fix issue #13",
      "push:autokit/issue-13",
      "getPrHead:51",
    ]);
  });

  it("continues fix from push_done without rerunning rebase or agent", async () => {
    const calls: AgentRunInput[] = [];
    const git = mockGitDeps([], [], {
      prHeadSha: "fix-head",
      baseSha: "base-sha",
    });
    const task = {
      ...fixingTask("review"),
      git: {
        ...baseTask().git,
        checkpoints: {
          ...baseTask().git.checkpoints,
          fix: {
            ...baseTask().git.checkpoints.fix,
            before_sha: "before-fix",
            rebase_done: "rebase-sha",
            agent_done: "agent-fix-sha",
            commit_done: "fix-commit",
            push_done: "fix-commit",
          },
        },
      },
    };

    const result = await runFixWorkflow(task, {
      runner: queueRunner(calls, []),
      git,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(result.task.state, "reviewing");
    assert.equal(calls.length, 0);
    assert.deepEqual(git.calls, ["getPrHead:51"]);
  });

  it("keeps CI fix counter independent when CI-origin fix returns through review", async () => {
    const ciFailed = transitionTask(
      { ...reviewingTask(), state: "ci_waiting", runtime_phase: "ci_wait", ci_fix_round: 0 },
      { type: "ci_failed" },
    );
    const git = mockGitDeps(["before-fix", "rebase-sha", "agent-fix-sha"], ["fix-commit"], {
      prHeadSha: "fix-head",
      baseSha: "base-sha",
    });

    const fixed = await runFixWorkflow(ciFailed, {
      runner: queueRunner(
        [],
        [
          completed("codex", {
            changed_files: ["packages/workflows/src/index.ts"],
            tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
            resolved_accept_ids: [],
            unresolved_accept_ids: [],
            notes: "ci fixed",
          }),
        ],
      ),
      git,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });
    const reviewed = await runReviewSuperviseWorkflow(fixed.task, {
      runner: queueRunner([], [completed("claude", { findings: [] })]),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(fixed.task.review_round, 0);
    assert.equal(fixed.task.ci_fix_round, 1);
    assert.equal(reviewed.task.state, "ci_waiting");
    assert.equal(reviewed.task.ci_fix_round, 1);
    assert.equal(reviewed.task.review_round, 0);
  });

  it("pauses fix on rebase conflict before running the agent", async () => {
    const calls: AgentRunInput[] = [];
    const git = mockGitDeps(["before-fix"], [], {
      rebase: { ok: false, message: "conflict" },
    });

    const result = await runFixWorkflow(fixingTask("review"), {
      runner: queueRunner(calls, []),
      git,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(result.task.state, "paused");
    assert.equal(result.task.failure?.code, "rebase_conflict");
    assert.deepEqual(calls, []);
    assert.deepEqual(git.calls, ["getHeadSha", "rebase"]);
  });
});

describe("ci-wait workflow", () => {
  it("reserves auto-merge only after CI success, head match, and mergeable", async () => {
    const github = mockCiDeps({
      checks: [{ status: "success" }],
      prs: [
        { headSha: "head-sha", mergeable: "MERGEABLE" },
        { headSha: "head-sha", mergeable: "MERGEABLE" },
      ],
    });

    const result = await runCiWaitWorkflow(ciWaitingTask(), {
      runner: queueRunner([], []),
      github,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(result.task.state, "merging");
    assert.equal(result.task.runtime_phase, "merge");
    assert.deepEqual(github.calls, [
      "checks:51",
      "getPr:51:pre_reservation_check",
      "reserve:51:head-sha",
      "getPr:51:post_reservation_recheck",
    ]);
  });

  it("pauses for manual merge without reserving auto-merge when disabled", async () => {
    const github = mockCiDeps({
      checks: [{ status: "success" }],
      prs: [{ headSha: "head-sha", mergeable: "MERGEABLE" }],
    });

    const result = await runCiWaitWorkflow(ciWaitingTask(), {
      runner: queueRunner([], []),
      github,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
      config: parseConfig({ auto_merge: false }),
    });

    assert.equal(result.task.state, "paused");
    assert.equal(result.task.failure?.code, "manual_merge_required");
    assert.deepEqual(github.calls, ["checks:51", "getPr:51:pre_reservation_check"]);
  });

  it("detects pre-reservation head mismatch and blocked mergeability before reserving", async () => {
    const mismatch = await runCiWaitWorkflow(ciWaitingTask(), {
      runner: queueRunner([], []),
      github: mockCiDeps({
        checks: [{ status: "success" }],
        prs: [{ headSha: "new-head", mergeable: "MERGEABLE" }],
      }),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });
    assert.equal(mismatch.task.failure?.code, "merge_sha_mismatch");

    const blocked = await runCiWaitWorkflow(ciWaitingTask(), {
      runner: queueRunner([], []),
      github: mockCiDeps({
        checks: [{ status: "success" }],
        prs: [{ headSha: "head-sha", mergeable: "BLOCKED" }],
      }),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });
    assert.equal(blocked.task.failure?.code, "branch_protection");
  });

  it("disables auto-merge and waits for the barrier on post-reservation head race", async () => {
    const github = mockCiDeps({
      checks: [{ status: "success" }],
      prs: [
        { headSha: "head-sha", mergeable: "MERGEABLE" },
        { headSha: "new-head", mergeable: "MERGEABLE" },
        { headSha: "new-head", mergeable: "MERGEABLE", autoMergeRequest: null },
        { headSha: "new-head", mergeable: "MERGEABLE", autoMergeRequest: null },
      ],
    });

    const result = await runCiWaitWorkflow(
      {
        ...ciWaitingTask(),
        review_findings: [{ round: 1, accept_ids: ["stale"], reject_ids: [], reject_reasons: {} }],
      },
      {
        runner: queueRunner([], []),
        github,
        repoRoot: "/repo",
        worktreeRoot: "/worktree",
      },
    );

    assert.equal(result.task.state, "paused");
    assert.equal(result.task.failure?.code, "merge_sha_mismatch");
    assert.deepEqual(result.task.review_findings[0].accept_ids, []);
    assert.deepEqual(github.calls, [
      "checks:51",
      "getPr:51:pre_reservation_check",
      "reserve:51:head-sha",
      "getPr:51:post_reservation_recheck",
      "disable:51",
      "sleep:5000",
      "getPr:51:auto_merge_disabled_barrier",
      "sleep:5000",
      "getPr:51:auto_merge_disabled_barrier",
    ]);
  });

  it("routes CI failure into ci-origin fix and preserves failed logs", async () => {
    const result = await runCiWaitWorkflow(ciWaitingTask(), {
      runner: queueRunner([], []),
      github: mockCiDeps({ checks: [{ status: "failure", failedLog: "test failed" }], prs: [] }),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(result.task.state, "fixing");
    assert.equal(result.task.runtime_phase, "fix");
    assert.equal(result.task.fix.origin, "ci");
    assert.equal(result.task.ci_fix_round, 1);
    assert.equal(result.ciFailureLog, "test failed");
  });

  it("fails CI failure when fix max rounds is exceeded", async () => {
    const result = await runCiWaitWorkflow(
      { ...ciWaitingTask(), ci_fix_round: 3 },
      {
        runner: queueRunner([], []),
        github: mockCiDeps({
          checks: [{ status: "failure", failedLog: "still failing" }],
          prs: [],
        }),
        repoRoot: "/repo",
        worktreeRoot: "/worktree",
      },
    );

    assert.equal(result.task.state, "failed");
    assert.equal(result.task.failure?.code, "ci_failure_max");
  });

  it("handles CI timeout paused and failed branches", async () => {
    const paused = await runCiWaitWorkflow(ciWaitingTask(), {
      runner: queueRunner([], []),
      github: mockCiDeps({ checks: [{ status: "pending" }], prs: [] }),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
      config: parseConfig({ ci: { timeout_ms: 100, poll_interval_ms: 10 } }),
      startedAtMs: 0,
      nowMs: queueNow([0, 101]),
    });
    assert.equal(paused.task.state, "paused");
    assert.equal(paused.task.failure?.code, "ci_timeout");

    const failedGithub = mockCiDeps({ checks: [{ status: "pending" }], prs: [] });
    const failed = await runCiWaitWorkflow(ciWaitingTask(), {
      runner: queueRunner([], []),
      github: failedGithub,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
      config: parseConfig({
        ci: { timeout_ms: 100, poll_interval_ms: 10, timeout_action: "failed" },
      }),
      startedAtMs: 0,
      nowMs: queueNow([0, 101]),
    });
    assert.equal(failed.task.state, "failed");
    assert.equal(failed.task.failure?.code, "ci_timeout");
    assert.deepEqual(failedGithub.calls, ["checks:51", "sleep:10", "disable:51"]);
  });
});

describe("merge and cleaning workflow", () => {
  it("moves merged PRs with matching head into cleaning", async () => {
    const github = mockMergeDeps({
      prs: [{ state: "MERGED", merged: true, headSha: "head-sha", mergeable: "MERGEABLE" }],
    });

    const result = await runMergeWorkflow(mergingTask(), {
      runner: queueRunner([], []),
      github,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(result.task.state, "cleaning");
    assert.equal(result.task.runtime_phase, null);
    assert.deepEqual(github.calls, ["getPr:51"]);
  });

  it("disables auto-merge for merge mismatch, blocked, closed, and timeout", async () => {
    const mismatchGithub = mockMergeDeps({
      prs: [{ state: "MERGED", merged: true, headSha: "new-head", mergeable: "MERGEABLE" }],
    });
    const mismatch = await runMergeWorkflow(mergingTask(), {
      runner: queueRunner([], []),
      github: mismatchGithub,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });
    assert.equal(mismatch.task.failure?.code, "merge_sha_mismatch");
    assert.deepEqual(mismatchGithub.calls, [
      "getPr:51",
      "disable:51",
      "sleep:5000",
      "getAutoMergeStatus:51",
      "sleep:5000",
      "getAutoMergeStatus:51",
    ]);

    const blockedGithub = mockMergeDeps({
      prs: [{ state: "OPEN", merged: false, headSha: "head-sha", mergeable: "BLOCKED" }],
    });
    const blocked = await runMergeWorkflow(mergingTask(), {
      runner: queueRunner([], []),
      github: blockedGithub,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });
    assert.equal(blocked.task.failure?.code, "branch_protection");
    assert.deepEqual(blockedGithub.calls, [
      "getPr:51",
      "disable:51",
      "sleep:5000",
      "getAutoMergeStatus:51",
      "sleep:5000",
      "getAutoMergeStatus:51",
    ]);

    const closedGithub = mockMergeDeps({
      prs: [{ state: "CLOSED", merged: false, headSha: "head-sha", mergeable: "UNKNOWN" }],
    });
    const closed = await runMergeWorkflow(mergingTask(), {
      runner: queueRunner([], []),
      github: closedGithub,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });
    assert.equal(closed.task.failure?.code, "other");
    assert.deepEqual(closedGithub.calls, [
      "getPr:51",
      "disable:51",
      "sleep:5000",
      "getAutoMergeStatus:51",
      "sleep:5000",
      "getAutoMergeStatus:51",
    ]);

    const timeoutGithub = mockMergeDeps({
      prs: [{ state: "OPEN", merged: false, headSha: "head-sha", mergeable: "UNKNOWN" }],
    });
    const timeout = await runMergeWorkflow(mergingTask(), {
      runner: queueRunner([], []),
      github: timeoutGithub,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
      config: parseConfig({ merge: { timeout_ms: 100, poll_interval_ms: 10 } }),
      startedAtMs: 0,
      nowMs: queueNow([0, 101]),
    });
    assert.equal(timeout.task.failure?.code, "merge_timeout");
    assert.deepEqual(timeoutGithub.calls, [
      "getPr:51",
      "sleep:10",
      "disable:51",
      "sleep:10",
      "getAutoMergeStatus:51",
      "sleep:10",
      "getAutoMergeStatus:51",
    ]);
  });

  it("cleans merged branch and worktree with forward-resume flags", async () => {
    const persisted: string[] = [];
    const cleanup = mockCleaningDeps({ branch: [{ ok: true }], worktree: [{ ok: true }] });

    const result = await runCleaningWorkflow(cleaningTask(), {
      runner: queueRunner([], []),
      cleanup,
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
      persistTask: (task) => {
        persisted.push(cleaningState(task));
      },
    });

    assert.equal(result.task.state, "merged");
    assert.equal(result.task.cleaning_progress.finalized_done, true);
    assert.deepEqual(cleanup.calls, [
      "sleep:5000",
      "deleteRemoteBranch:autokit/issue-13",
      "removeWorktree:.autokit/worktrees/issue-13:false",
    ]);
    assert.deepEqual(persisted, [
      "grace=true branch=false worktree=false finalized=false attempts=0 state=cleaning",
      "grace=true branch=true worktree=false finalized=false attempts=0 state=cleaning",
      "grace=true branch=true worktree=true finalized=false attempts=0 state=cleaning",
      "grace=true branch=true worktree=true finalized=true attempts=0 state=merged",
    ]);

    const resumedCleanup = mockCleaningDeps({ branch: [], worktree: [{ ok: true }] });
    const resumed = await runCleaningWorkflow(
      {
        ...cleaningTask(),
        cleaning_progress: {
          grace_period_done: true,
          branch_deleted_done: true,
          worktree_removed_done: false,
          finalized_done: false,
          worktree_remove_attempts: 0,
        },
      },
      {
        runner: queueRunner([], []),
        cleanup: resumedCleanup,
        repoRoot: "/repo",
        worktreeRoot: "/worktree",
      },
    );
    assert.equal(resumed.task.state, "merged");
    assert.deepEqual(resumedCleanup.calls, ["removeWorktree:.autokit/worktrees/issue-13:false"]);
  });

  it("pauses cleaning on branch and worktree cleanup failures", async () => {
    const branchFailure = await runCleaningWorkflow(cleaningTask(), {
      runner: queueRunner([], []),
      cleanup: mockCleaningDeps({
        branch: [{ ok: false, message: "denied /Users/tester/.codex/auth.json /repo/root" }],
        worktree: [],
      }),
      repoRoot: "/repo/root",
      worktreeRoot: "/worktree",
      homeDir: "/Users/tester",
    });
    assert.equal(branchFailure.task.failure?.code, "branch_delete_failed");
    assert.doesNotMatch(branchFailure.task.failure?.message ?? "", /\/Users\/tester|\/repo\/root/);
    assert.equal(
      branchFailure.task.failure_history[0].message,
      branchFailure.task.failure?.message,
    );

    const cleanup = mockCleaningDeps({
      branch: [{ ok: true }],
      worktree: [
        { ok: false, message: "locked-1" },
        { ok: false, message: "locked-2" },
        { ok: false, message: "locked-3" },
        { ok: false, message: "force failed" },
      ],
      prune: { ok: false, message: `prune failed sk-${"a".repeat(24)} /repo/root` },
    });
    const worktreeFailure = await runCleaningWorkflow(cleaningTask(), {
      runner: queueRunner([], []),
      cleanup,
      repoRoot: "/repo/root",
      worktreeRoot: "/worktree",
    });
    assert.equal(worktreeFailure.task.failure?.code, "worktree_remove_failed");
    assert.equal(worktreeFailure.task.cleaning_progress.worktree_remove_attempts, 3);
    assert.doesNotMatch(worktreeFailure.task.failure?.message ?? "", /sk-|\/repo\/root/);
    assert.equal(
      worktreeFailure.task.failure_history.at(-1)?.message,
      worktreeFailure.task.failure?.message,
    );
    assert.deepEqual(cleanup.calls, [
      "sleep:5000",
      "deleteRemoteBranch:autokit/issue-13",
      "removeWorktree:.autokit/worktrees/issue-13:false",
      "sleep:1000",
      "removeWorktree:.autokit/worktrees/issue-13:false",
      "sleep:3000",
      "removeWorktree:.autokit/worktrees/issue-13:false",
      "removeWorktree:.autokit/worktrees/issue-13:true",
      "pruneWorktrees",
    ]);
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

  it("records rejected findings even when the same supervisor round accepts other findings", async () => {
    const accepted = reviewFinding({ title: "Must fix" });
    const acceptedId = computeFindingId(accepted);
    const rejected = reviewFinding({ title: "Known trade-off" });
    const rejectedId = computeFindingId(rejected);

    const result = await runReviewSuperviseWorkflow(reviewingTask(), {
      runner: queueRunner(
        [],
        [
          completed("claude", { findings: [accepted, rejected] }),
          completed("claude", {
            accept_ids: [acceptedId],
            reject_ids: [rejectedId],
            reject_reasons: { [rejectedId]: "Intentional for MVP." },
            fix_prompt: "Fix accepted finding only.",
          }),
        ],
      ),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(result.task.state, "fixing");
    assert.equal(result.task.review_findings[0].round, 1);
    assert.deepEqual(result.task.review_findings[0].reject_ids, [rejectedId]);
    assert.equal(result.task.review_findings[0].reject_reasons[rejectedId], "Intentional for MVP.");
    assert.equal(result.task.reject_history.length, 1);
    assert.equal(result.task.reject_history[0].finding_id, rejectedId);
    assert.equal(result.task.reject_history[0].reason, "Intentional for MVP.");
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

  it("rejects attempts to accept a known rejected finding in mixed rounds", async () => {
    const known = reviewFinding({ title: "Known reject" });
    const knownId = computeFindingId(known);
    const fresh = reviewFinding({ title: "New reject" });
    const freshId = computeFindingId(fresh);
    const task = {
      ...reviewingTask(),
      reject_history: [
        {
          finding_id: knownId,
          rejected_at_round: 1,
          reason: "Accepted trade-off.",
        },
      ],
    };

    const result = await runReviewSuperviseWorkflow(task, {
      runner: queueRunner(
        [],
        [
          completed("claude", { findings: [known, fresh] }),
          completed("claude", {
            accept_ids: [knownId],
            reject_ids: [freshId],
            reject_reasons: { [freshId]: "Reject fresh finding." },
            fix_prompt: "Fix known finding.",
          }),
          completed("claude", {
            accept_ids: [knownId],
            reject_ids: [freshId],
            reject_reasons: { [freshId]: "Reject fresh finding." },
            fix_prompt: "Fix known finding.",
          }),
        ],
      ),
      repoRoot: "/repo",
      worktreeRoot: "/worktree",
    });

    assert.equal(result.task.state, "failed");
    assert.equal(result.task.failure?.code, "prompt_contract_violation");
    assert.match(result.task.failure?.message ?? "", /known rejected/);
  });

  it("redacts persisted review findings and supervisor decisions", async () => {
    const finding = reviewFinding({
      file: "/repo/root/packages/core/src/index.ts",
      title: `Token ghp_${"a".repeat(24)}`,
      rationale: "/Users/tester/.codex/auth.json is mentioned.",
      suggested_fix: "/repo/root/.env:4 SECRET=raw-secret",
    });
    const id = computeFindingId({
      ...finding,
      file: "<repo>/packages/core/src/index.ts",
      title: "Token <REDACTED>",
    });

    const result = await runReviewSuperviseWorkflow(reviewingTask(), {
      runner: queueRunner(
        [],
        [
          completed("claude", { findings: [finding] }),
          completed("claude", {
            accept_ids: [],
            reject_ids: [id],
            reject_reasons: {
              [id]: `reject sk-${"b".repeat(24)} at /Users/tester/.codex/auth.json`,
            },
          }),
        ],
      ),
      repoRoot: "/repo/root",
      worktreeRoot: "/repo/root/.autokit/worktrees/issue-13",
      homeDir: "/Users/tester",
    });

    assert.equal(result.task.state, "ci_waiting");
    assert.equal(result.findings[0].file, "<repo>/packages/core/src/index.ts");
    assert.equal(result.findings[0].title, "token <redacted>");
    assert.doesNotMatch(
      result.findings[0].rationale,
      /\/Users\/tester|\.codex\/auth\.json|ghp_|sk-|raw-secret/,
    );
    assert.match(result.findings[0].rationale, /<REDACTED>/);
    assert.equal(result.findings[0].suggested_fix, "<repo>/.env:4 SECRET=<REDACTED>");
    assert.equal(
      result.task.review_findings[0].reject_reasons[id],
      "reject <REDACTED> at <REDACTED>",
    );
    assert.equal(result.task.reject_history[0].reason, "reject <REDACTED> at <REDACTED>");
  });

  it("uses deterministic finding ids from normalized file and title", () => {
    const finding = reviewFinding({
      file: "./packages\\core/src/index.ts",
      title: "  Contract   issue ",
    });
    const assigned = assignFindingIds([finding]);

    assert.equal(assigned[0].file, "packages/core/src/index.ts");
    assert.equal(assigned[0].title, "contract issue");
    assert.equal(assigned[0].finding_id, computeFindingId(finding));
    assert.equal(
      computeFindingId(reviewFinding({ title: "Contract issue" })),
      computeFindingId(reviewFinding({ title: "contract issue" })),
    );
    assert.equal(assigned[0].finding_id.length, 16);
  });
});

function baseTask() {
  return createTaskEntry({
    issue: 13,
    slug: "ak-012",
    title: "AK-012",
    labels: ["agent-ready"],
    now: "2026-05-05T09:00:00+09:00",
  });
}

function implementReadyTask(): TaskEntry {
  const task = baseTask();
  return {
    ...task,
    state: "planned" as const,
    runtime_phase: null,
    branch: "autokit/issue-13",
    worktree_path: ".autokit/worktrees/issue-13",
    plan: { ...task.plan, state: "verified" as const },
  };
}

function reviewingTask() {
  return transitionTask(
    {
      ...baseTask(),
      state: "implementing",
      runtime_phase: "implement",
    },
    { type: "pr_ready", headSha: "head-sha", prNumber: 51, baseSha: "base-sha" },
  );
}

function fixingTask(origin: "review" | "ci") {
  return {
    ...reviewingTask(),
    state: "fixing" as const,
    runtime_phase: "fix" as const,
    fix: { origin, started_at: "2026-05-05T10:00:00+09:00", ci_failure_log: null },
    branch: "autokit/issue-13",
  };
}

function ciWaitingTask() {
  return {
    ...reviewingTask(),
    state: "ci_waiting" as const,
    runtime_phase: "ci_wait" as const,
    pr: { ...reviewingTask().pr, number: 51, head_sha: "head-sha", base_sha: "base-sha" },
    review_findings: [{ round: 1, accept_ids: [], reject_ids: [], reject_reasons: {} }],
  };
}

function mergingTask() {
  return transitionTask(ciWaitingTask(), { type: "auto_merge_reserved" });
}

function cleaningTask() {
  return {
    ...transitionTask(mergingTask(), { type: "pr_merged", headSha: "head-sha" }),
    branch: "autokit/issue-13",
    worktree_path: ".autokit/worktrees/issue-13",
  };
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

function mockMergeDeps(input: { prs: MergePrObservation[] }): MergeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getPr: (prNumber) => {
      calls.push(`getPr:${prNumber}`);
      const next = input.prs.shift();
      assert.ok(next, "expected queued merge PR observation");
      return next;
    },
    disableAutoMerge: (prNumber) => {
      calls.push(`disable:${prNumber}`);
    },
    getAutoMergeStatus: (prNumber) => {
      calls.push(`getAutoMergeStatus:${prNumber}`);
      return { autoMergeRequest: null };
    },
    sleep: (ms) => {
      calls.push(`sleep:${ms}`);
    },
  };
}

function mockCleaningDeps(input: {
  branch: Array<{ ok: true } | { ok: false; message: string }>;
  worktree: Array<{ ok: true } | { ok: false; message: string }>;
  prune?: { ok: true } | { ok: false; message: string };
}): CleaningDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deleteRemoteBranch: (branch) => {
      calls.push(`deleteRemoteBranch:${branch}`);
      const next = input.branch.shift();
      assert.ok(next, "expected queued branch cleanup result");
      return next;
    },
    removeWorktree: (worktreePath, options) => {
      calls.push(`removeWorktree:${worktreePath}:${options.force}`);
      const next = input.worktree.shift();
      assert.ok(next, "expected queued worktree cleanup result");
      return next;
    },
    pruneWorktrees: () => {
      calls.push("pruneWorktrees");
      assert.ok(input.prune, "expected queued prune result");
      return input.prune;
    },
    sleep: (ms) => {
      calls.push(`sleep:${ms}`);
    },
  };
}

function cleaningState(task: TaskEntry): string {
  const progress = task.cleaning_progress;
  return [
    `grace=${progress.grace_period_done}`,
    `branch=${progress.branch_deleted_done}`,
    `worktree=${progress.worktree_removed_done}`,
    `finalized=${progress.finalized_done}`,
    `attempts=${progress.worktree_remove_attempts}`,
    `state=${task.state}`,
  ].join(" ");
}

function mockCiDeps(input: {
  checks: CiCheckObservation[];
  prs: CiWaitPrObservation[];
}): CiWaitDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getChecks: (prNumber) => {
      calls.push(`checks:${prNumber}`);
      const next = input.checks.shift();
      assert.ok(next, "expected queued CI check observation");
      return next;
    },
    getPr: (prNumber, site) => {
      calls.push(`getPr:${prNumber}:${site}`);
      const next = input.prs.shift();
      assert.ok(next, "expected queued PR observation");
      return next;
    },
    reserveAutoMerge: ({ prNumber, headSha }) => {
      calls.push(`reserve:${prNumber}:${headSha}`);
    },
    disableAutoMerge: (prNumber) => {
      calls.push(`disable:${prNumber}`);
    },
    sleep: (ms) => {
      calls.push(`sleep:${ms}`);
    },
  };
}

function queueNow(values: number[]): () => number {
  return () => {
    const next = values.shift();
    assert.ok(next !== undefined, "expected queued timestamp");
    return next;
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

function mockGitDeps(
  headShas: string[],
  commitShas: string[],
  options: {
    prNumber?: number;
    prHeadSha?: string;
    baseSha?: string | null;
    branchPr?: BranchPrLookup;
    rebase?: { ok: true } | { ok: false; message: string };
  } = {},
): ImplementFixGitDeps & { calls: string[] } {
  const calls: string[] = [];
  const deps: ImplementFixGitDeps & { calls: string[] } = {
    calls,
    getHeadSha: () => {
      calls.push("getHeadSha");
      const sha = headShas.shift();
      assert.ok(sha, "expected a queued head sha");
      return sha;
    },
    stageAll: () => {
      calls.push("stageAll");
    },
    commit: ({ message }) => {
      calls.push(`commit:${message}`);
      const sha = commitShas.shift();
      assert.ok(sha, "expected a queued commit sha");
      return sha;
    },
    pushBranch: (branch) => {
      calls.push(`push:${branch}`);
    },
    createDraftPr: ({ headSha }) => {
      calls.push(`createDraftPr:${headSha}`);
      return options.prNumber ?? 51;
    },
    getPrHead: (prNumber) => {
      calls.push(`getPrHead:${prNumber}`);
      return { headSha: options.prHeadSha ?? "remote-head", baseSha: options.baseSha ?? null };
    },
    markPrReady: (prNumber) => {
      calls.push(`markPrReady:${prNumber}`);
    },
    rebaseOntoBase: () => {
      calls.push("rebase");
      return options.rebase ?? { ok: true };
    },
  };
  if (options.branchPr !== undefined) {
    deps.findPrForBranch = (branch) => {
      calls.push(`findPrForBranch:${branch}`);
      return options.branchPr ?? { state: "NONE" };
    };
  }
  return deps;
}

function implementCheckpointState(task: TaskEntry): string {
  const checkpoint = task.git.checkpoints.implement;
  return [
    `before=${checkpoint.before_sha}`,
    `agent=${checkpoint.agent_done}`,
    `commit=${checkpoint.commit_done}`,
    `push=${checkpoint.push_done}`,
    `pr=${checkpoint.pr_created}`,
    `head=${checkpoint.head_sha_persisted}`,
    `after=${checkpoint.after_sha}`,
  ].join(" ");
}
