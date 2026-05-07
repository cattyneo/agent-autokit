import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runProductionWorkflow, type WorkflowExecFile } from "../../packages/cli/src/executor.ts";
import { runCli } from "../../packages/cli/src/index.ts";
import {
  type AgentRunInput,
  createTaskEntry,
  loadTasksFile,
  type TaskEntry,
  type TasksFile,
  writeTasksFileAtomic,
} from "../../packages/core/src/index.ts";
import type { WorkflowRunner } from "../../packages/workflows/src/index.ts";
import { type GhJsonRunner, verifyUnprotectedSmoke } from "./full-run.ts";

const NOW = "2026-05-07T15:00:00+09:00";

describe("Phase 1 E2E gate", () => {
  it("runs the Phase 1 golden path with fake runners, override effort, self-correction, resume, and smoke evidence", async () => {
    const root = makeTempDir();
    writePhase1Config(root);
    writePromptAssets(root);
    writeTasks(root, [task(97)]);
    const commands: string[] = [];
    const calls: AgentRunInput[] = [];
    const runner = phase1Runner(calls);
    const execFile = mockExecFile(root, commands);

    const pausedTasks = await runProductionWorkflow({
      cwd: root,
      env: {},
      execFile,
      runner,
      maxSteps: 20,
      now: () => NOW,
      phaseOverride: { phase: "plan", provider: "codex", effort: "high" },
    });

    const paused = pausedTasks[0];
    assert.equal(paused.state, "paused");
    assert.equal(paused.failure?.code, "need_input_pending");
    assert.equal(paused.runtime.previous_state, "reviewing");
    assert.equal(paused.runtime.phase_self_correct_done, true);

    const resumeExit = await runCli(["resume", "97"], {
      cwd: root,
      env: {},
      execFile,
      workflowRunner: runner,
      workflowMaxSteps: 20,
      now: () => NOW,
      stdout: { write: () => undefined },
      stderr: { write: (chunk) => assert.fail(chunk) },
    });

    assert.equal(resumeExit, 0);
    const finalTasks = loadTasks(root);
    const finalTask = finalTasks[0];
    assert.equal(finalTask.state, "merged");
    assert.deepEqual(
      calls.map((call) => [call.phase, call.provider]),
      [
        ["plan", "codex"],
        ["plan_verify", "codex"],
        ["implement", "claude"],
        ["review", "claude"],
        ["review", "claude"],
        ["review", "claude"],
      ],
    );

    const overridePlan = calls[0];
    assert.equal(overridePlan.model, "gpt-5.5");
    assert.equal(finalTask.runtime.resolved_model.plan, "gpt-5.5");
    assert.deepEqual(overridePlan.effort, {
      phase: "plan",
      provider: "codex",
      effort: "high",
      downgraded_from: null,
      timeout_ms: 900_000,
    });
    assert.equal(overridePlan.effective_permission?.permission_profile, "readonly_repo");
    assert.deepEqual(overridePlan.effective_permission?.codex, {
      sandbox: "read-only",
      network: "off",
    });

    const implementCall = calls.find((call) => call.phase === "implement");
    assert.ok(implementCall);
    assert.equal(implementCall.provider, "claude");
    assert.equal(implementCall.effective_permission?.permission_profile, "write_worktree");
    assert.equal(implementCall.effective_permission?.claude?.hook, "write_path_guard");
    assert.equal(implementCall.permissions.workspaceScope, "worktree");

    const firstResumeReviewCall = calls[4];
    assert.equal(firstResumeReviewCall.phase, "review");
    assert.equal(firstResumeReviewCall.provider, "claude");

    const logText = readFileSync(join(root, ".autokit", "logs", "2026-05-07.log"), "utf8");
    assert.match(logText, /"kind":"phase_override_started"/);
    assert.match(logText, /"kind":"phase_override_ended"/);
    assert.deepEqual(
      readAuditKinds(logText).filter((kind) => kind === "phase_completed"),
      ["phase_completed", "phase_completed", "phase_completed", "phase_completed"],
    );
    assert.match(logText, /"kind":"phase_self_correct"/);
    assert.match(logText, /"kind":"auto_merge_reserved"/);
    assert.match(logText, /"kind":"branch_deleted"/);
    assert.match(logText, /"kind":"sanitize_pass_hmac"/);
    assert.equal((logText.match(/"kind":"need_input_pending"/g) ?? []).length, 1);
    assert.doesNotMatch(logText, /"kind":"effort_downgrade"/);

    assert.equal(
      commands.some((command) => command.startsWith("claude ")),
      false,
    );
    assert.equal(
      commands.some((command) => command.startsWith("codex ")),
      false,
    );
    assert.ok(commands.includes("gh pr merge 97 --auto --rebase --match-head-commit remote-head"));
    assert.ok(commands.includes("git push origin --delete autokit/issue-97"));
    assert.ok(commands.includes("git worktree remove .autokit/worktrees/issue-97"));
    assert.equal(
      commands.some((command) => command.includes("git worktree remove --force")),
      false,
    );
    assert.equal(commands.includes("git worktree prune"), false);
    assert.equal(existsSync(join(root, ".autokit", "reviews", "issue-97-review-1.md")), true);
    assert.equal(existsSync(join(root, ".autokit", "worktrees", "issue-97")), false);

    const smoke = verifyUnprotectedSmoke({
      repoPath: root,
      ownerRepo: "cattyneo/agent-autokit-e2e-fixture",
      issue: 97,
      runExitCode: 0,
      gh: fakeGhSmoke(),
    });
    assert.deepEqual(
      smoke.observations
        .filter((observation) => !observation.passed)
        .map((observation) => [observation.id, observation.evidence]),
      [["OBS-07", "need_input_pending"]],
    );
    assert.deepEqual(
      smoke.observations
        .filter((observation) => observation.id !== "OBS-07")
        .filter((observation) => !observation.passed)
        .map((observation) => [observation.id, observation.evidence]),
      [],
    );
  });
});

function phase1Runner(calls: AgentRunInput[]): WorkflowRunner {
  let reviewCalls = 0;
  return async (input) => {
    calls.push(input);
    switch (input.phase) {
      case "plan":
        return completed(input.provider, {
          plan_markdown: "## Phase 1 golden path plan",
          assumptions: [],
          risks: [],
        });
      case "plan_verify":
        return completed(input.provider, { result: "ok", findings: [] });
      case "implement":
        return completed(input.provider, {
          changed_files: ["packages/cli/src/executor.ts"],
          tests_run: [{ command: "bun test e2e/runners/phase1-gate.test.ts", result: "passed" }],
          docs_updated: false,
          notes: "implemented",
        });
      case "review":
        reviewCalls += 1;
        if (reviewCalls === 1) {
          throw Object.assign(new Error("review payload shape drift"), {
            code: "prompt_contract_violation",
          });
        }
        if (reviewCalls === 2) {
          return {
            status: "need_input",
            summary: "operator confirmation required after self-correction",
            question: { text: "Resume review?", default: "yes" },
          };
        }
        return completed(input.provider, { findings: [] });
      default:
        throw new Error(`unexpected phase: ${input.phase}`);
    }
  };
}

function mockExecFile(root: string, commands: string[]): WorkflowExecFile {
  const expectedWorktree = join(root, ".autokit", "worktrees", "issue-97");
  const expectedWorktreeInput = ".autokit/worktrees/issue-97";
  const revParseResults = [
    "base-sha",
    "base-sha",
    "base-sha",
    "agent-sha",
    "commit-sha",
    "remote-head",
  ];
  return (command, args) => {
    const line = `${command} ${args.join(" ")}`;
    commands.push(line);

    if (line === "git fetch origin main") {
      return "";
    }
    if (
      command === "git" &&
      args[0] === "worktree" &&
      args[1] === "add" &&
      args[2] === "-b" &&
      args[3] === "autokit/issue-97" &&
      args[5] === "origin/main"
    ) {
      assert.equal(args[4], expectedWorktree);
      mkdirSync(expectedWorktree, { recursive: true });
      return "";
    }
    if (line === "git add -A") {
      return "";
    }
    if (line === "git commit -m Implement issue #97") {
      return "";
    }
    if (line === "git push -u origin autokit/issue-97") {
      return "";
    }
    if (line === "gh issue view 97 --json number,title,body,labels,state,url") {
      return JSON.stringify({
        number: 97,
        title: "[v0.2 P1-E2E] Phase 1 E2E gate",
        body: "Phase 1 golden path fixture",
        labels: [{ name: "agent-ready" }, { name: "type:test" }],
        state: "OPEN",
        url: "https://github.com/cattyneo/agent-autokit/issues/97",
      });
    }
    if (line === "git rev-parse HEAD") {
      const next = revParseResults.shift();
      assert.ok(next, "expected queued rev-parse result");
      return next;
    }
    if (
      line ===
      "gh pr list --head autokit/issue-97 --state all --json number,state,headRefOid,baseRefOid --limit 1"
    ) {
      return "[]";
    }
    if (line.startsWith("gh pr create --draft")) {
      return "https://github.com/cattyneo/agent-autokit/pull/97";
    }
    if (line === "gh pr view 97 --json headRefOid,baseRefOid") {
      return JSON.stringify({ headRefOid: "remote-head", baseRefOid: "base-sha" });
    }
    if (line === "gh pr ready 97") {
      return "";
    }
    if (line === "gh pr view 97 --json statusCheckRollup") {
      return JSON.stringify({
        statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
      });
    }
    if (line === "gh pr view 97 --json headRefOid,mergeable,mergeStateStatus,autoMergeRequest") {
      return JSON.stringify({
        headRefOid: "remote-head",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        autoMergeRequest: null,
      });
    }
    if (line === "gh pr view 97 --json state,mergedAt,headRefOid,mergeable,mergeStateStatus") {
      return JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-05-07T06:00:00Z",
        headRefOid: "remote-head",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      });
    }
    if (line === "gh pr merge 97 --auto --rebase --match-head-commit remote-head") {
      return "";
    }
    if (line === "git push origin --delete autokit/issue-97") {
      return "";
    }
    if (
      command === "git" &&
      args[0] === "worktree" &&
      args[1] === "remove" &&
      args[2] === expectedWorktreeInput
    ) {
      rmSync(expectedWorktree, { recursive: true, force: true });
      assert.equal(existsSync(expectedWorktree), false);
      return "";
    }
    if (line === "git worktree prune") {
      return "";
    }
    throw new Error(`unexpected exec: ${line}`);
  };
}

function fakeGhSmoke(): GhJsonRunner {
  return (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return {
        ok: true,
        stdout: { state: "MERGED", mergedAt: "2026-05-07T06:00:00Z", headRefOid: "remote-head" },
        status: 0,
      };
    }
    if (args[0] === "api") {
      return { ok: false, stderr: "gh: Branch not found (HTTP 404)", status: 1 };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
}

function completed(provider: "claude" | "codex", structured: Record<string, unknown>) {
  return {
    status: "completed" as const,
    summary: "ok",
    structured,
    session:
      provider === "claude"
        ? { claudeSessionId: "claude-phase1-session" }
        : { codexSessionId: "codex-phase1-session" },
  };
}

function task(issue: number): TaskEntry {
  return createTaskEntry({
    issue,
    slug: "phase1-e2e-gate",
    title: "[v0.2 P1-E2E] Phase 1 E2E gate",
    labels: ["agent-ready", "type:test"],
    now: NOW,
  });
}

function writeTasks(root: string, tasks: TaskEntry[]): void {
  mkdirSync(join(root, ".autokit"), { recursive: true });
  writeFileSync(join(root, ".autokit", "audit-hmac-key"), "phase1-fixture-hmac-key", {
    mode: 0o600,
  });
  const tasksFile: TasksFile = { version: 1, generated_at: NOW, tasks };
  writeTasksFileAtomic(join(root, ".autokit", "tasks.yaml"), tasksFile);
}

function loadTasks(root: string): TaskEntry[] {
  return loadTasksFile(join(root, ".autokit", "tasks.yaml")).tasks;
}

function writePhase1Config(root: string): void {
  mkdirSync(join(root, ".autokit"), { recursive: true });
  writeFileSync(
    join(root, ".autokit", "config.yaml"),
    `
version: 1
base_branch: main
ci:
  poll_interval_ms: 1
  timeout_ms: 1000
merge:
  poll_interval_ms: 1
  timeout_ms: 1000
  branch_delete_grace_ms: 1
phases:
  plan:
    provider: claude
    model: gpt-5.5
  implement:
    provider: claude
runner_timeout:
  plan_ms: 900000
  plan_verify_ms: 222
  implement_ms: 333
  review_ms: 444
  default_ms: 666
`,
    { mode: 0o600 },
  );
}

function writePromptAssets(root: string): void {
  const promptDir = join(root, ".agents", "prompts");
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(
    join(promptDir, "plan-verify.md"),
    "# plan-verify\n\nDo not execute shell commands.\n",
    { mode: 0o600 },
  );
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autokit-phase1-gate-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readAuditKinds(logText: string): string[] {
  return logText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind?: string })
    .flatMap((entry) => (entry.kind === undefined ? [] : [entry.kind]));
}
