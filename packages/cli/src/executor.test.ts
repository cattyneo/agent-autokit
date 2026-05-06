import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  type AgentRunInput,
  createTaskEntry,
  loadTasksFile,
  type TaskEntry,
  type TasksFile,
  writeTasksFileAtomic,
} from "@cattyneo/autokit-core";
import type { WorkflowRunner } from "@cattyneo/autokit-workflows";

import { runProductionWorkflow, type WorkflowExecFile } from "./executor.ts";

const NOW = "2026-05-05T10:00:00+09:00";

describe("production workflow executor", () => {
  it("drives a queued task through PR creation, auto-merge reservation, and cleanup", async () => {
    const root = makeTempDir();
    writeFastConfig(root);
    writePromptAssets(root);
    writeTasks(root, [task(58)]);
    const calls: AgentRunInput[] = [];
    const commands: string[] = [];

    const tasks = await runProductionWorkflow({
      cwd: root,
      env: {},
      execFile: mockExecFile(commands),
      runner: queueRunner(calls),
      maxSteps: 20,
      now: () => NOW,
    });

    assert.equal(tasks[0].state, "merged");
    assert.equal(tasks[0].runtime_phase, null);
    assert.equal(tasks[0].pr.number, 29);
    assert.equal(tasks[0].pr.head_sha, "remote-head");
    assert.deepEqual(
      calls.map((call) => [call.provider, call.phase, call.permissions.workspaceScope]),
      [
        ["claude", "plan", "repo"],
        ["codex", "plan_verify", "repo"],
        ["codex", "implement", "worktree"],
        ["claude", "review", "worktree"],
      ],
    );
    assert.deepEqual(
      calls.map((call) => [call.phase, call.timeoutMs]),
      [
        ["plan", 111],
        ["plan_verify", 222],
        ["implement", 333],
        ["review", 444],
      ],
    );
    assert.ok(commands.includes("gh pr merge 29 --auto --rebase --match-head-commit remote-head"));
    assert.ok(commands.includes("git push origin --delete autokit/issue-58"));
    assert.ok(commands.includes("git worktree remove .autokit/worktrees/issue-58"));
    assert.equal(loadTasksFile(tasksPath(root)).tasks[0].state, "merged");
    assert.equal(existsSync(join(root, ".autokit", "reviews", "issue-58-review-1.md")), true);
    const logText = readFileSync(join(root, ".autokit", "logs", "2026-05-05.log"), "utf8");
    assert.match(logText, /"kind":"sanitize_pass_hmac"/);
    assert.match(logText, /"sanitize_hmac":"[a-f0-9]{64}"/);
    assert.match(logText, /"kind":"auto_merge_reserved"/);
    assert.match(logText, /"kind":"branch_deleted"/);
    assert.doesNotMatch(logText, /Wire production autokit run/);
    assert.match(calls[1].prompt, /# plan-verify/);
    assert.match(calls[1].prompt, /Do not execute shell commands/);
    assert.match(calls[1].prompt, /Current plan:/);
    assert.match(calls[1].prompt, /## Plan/);
    assert.doesNotMatch(calls[1].prompt, /\(none yet\)/);
  });

  it("fails closed before any runner dispatch when API key env is exported", async () => {
    const root = makeTempDir();
    writeTasks(root, [task(58)]);
    const calls: AgentRunInput[] = [];

    await assert.rejects(
      () =>
        runProductionWorkflow({
          cwd: root,
          env: { ANTHROPIC_API_KEY: "dummy" },
          execFile: () => {
            throw new Error("unexpected command");
          },
          runner: async (input) => {
            calls.push(input);
            return { status: "completed", summary: "unexpected" };
          },
        }),
      /ANTHROPIC_API_KEY must not be exported/,
    );
    assert.equal(calls.length, 0);
  });

  it("uses resolved effort timeout and emits downgrade audit in production", async () => {
    const root = makeTempDir();
    writeConfig(
      root,
      `
version: 1
base_branch: main
effort:
  unsupported_policy: downgrade
phases:
  plan:
    provider: claude
    effort: high
    model: ${root}/claude-haiku-sk-${"a".repeat(24)}
`,
    );
    writePromptAssets(root);
    writeTasks(root, [task(58)]);
    const calls: AgentRunInput[] = [];
    const commands: string[] = [];

    const tasks = await runProductionWorkflow({
      cwd: root,
      env: {},
      execFile: mockExecFile(commands),
      runner: queueRunner(calls),
      maxSteps: 1,
      now: () => NOW,
    });

    assert.equal(tasks[0].state, "planned");
    assert.equal(calls[0].phase, "plan");
    assert.equal(calls[0].effort?.effort, "medium");
    assert.equal(calls[0].effort?.downgraded_from, "high");
    assert.equal(calls[0].effort?.timeout_ms, 1_800_000);
    assert.equal(calls[0].timeoutMs, 1_800_000);
    const logText = readFileSync(join(root, ".autokit", "logs", "2026-05-05.log"), "utf8");
    assert.match(logText, /"kind":"effort_downgrade"/);
    assert.doesNotMatch(logText, new RegExp(escapeRegExp(root)));
    assert.doesNotMatch(logText, /sk-/);
  });

  it("does not mark remote branch deletion as complete for non-gone git errors", async () => {
    const root = makeTempDir();
    writeFastConfig(root);
    const cleaningTask = {
      ...task(58),
      state: "cleaning" as const,
      pr: { ...task(58).pr, number: 29, head_sha: "remote-head" },
    };
    writeTasks(root, [cleaningTask]);
    const commands: string[] = [];

    const tasks = await runProductionWorkflow({
      cwd: root,
      env: {},
      execFile: (command, args) => {
        const line = `${command} ${args.join(" ")}`;
        commands.push(line);
        if (line === "git push origin --delete autokit/issue-58") {
          throw new Error("Repository not found.");
        }
        return "";
      },
      runner: async () => ({ status: "completed", summary: "unexpected" }),
      maxSteps: 3,
      now: () => NOW,
    });

    assert.equal(tasks[0].state, "paused");
    assert.equal(tasks[0].failure?.code, "branch_delete_failed");
    assert.equal(tasks[0].cleaning_progress.branch_deleted_done, false);
    assert.ok(commands.includes("git push origin --delete autokit/issue-58"));
  });
});

function mockExecFile(commands: string[]): WorkflowExecFile {
  const revParseResults = ["base-sha", "agent-sha", "commit-sha"];
  return (command, args) => {
    const line = `${command} ${args.join(" ")}`;
    commands.push(line);

    if (line === "gh issue view 58 --json number,title,body,labels,state,url") {
      return JSON.stringify({
        number: 58,
        title: "[AK-018a] production run workflow executor",
        body: "Wire production autokit run.",
        labels: [{ name: "agent-ready" }],
        state: "OPEN",
        url: "https://github.com/cattyneo/agent-autokit/issues/58",
      });
    }
    if (line === "git rev-parse HEAD") {
      const next = revParseResults.shift();
      assert.ok(next, "expected queued rev-parse result");
      return next;
    }
    if (
      line ===
      "gh pr list --head autokit/issue-58 --state all --json number,state,headRefOid,baseRefOid --limit 1"
    ) {
      return "[]";
    }
    if (line.startsWith("gh pr create --draft")) {
      return "https://github.com/cattyneo/agent-autokit/pull/29";
    }
    if (line === "gh pr view 29 --json headRefOid,baseRefOid") {
      return JSON.stringify({ headRefOid: "remote-head", baseRefOid: "base-sha" });
    }
    if (line === "gh pr view 29 --json statusCheckRollup") {
      return JSON.stringify({
        statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
      });
    }
    if (line === "gh pr view 29 --json headRefOid,mergeable,mergeStateStatus,autoMergeRequest") {
      return JSON.stringify({
        headRefOid: "remote-head",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        autoMergeRequest: null,
      });
    }
    if (line === "gh pr view 29 --json state,mergedAt,headRefOid,mergeable,mergeStateStatus") {
      return JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-05-05T01:00:00Z",
        headRefOid: "remote-head",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      });
    }
    return "";
  };
}

function queueRunner(calls: AgentRunInput[]): WorkflowRunner {
  const outputs = [
    completed("claude", { plan_markdown: "## Plan", assumptions: [], risks: [] }),
    completed("codex", { result: "ok", findings: [] }),
    completed("codex", {
      changed_files: ["packages/cli/src/executor.ts"],
      tests_run: [
        { command: "bun test packages/cli/src/executor.test.ts", result: "passed", summary: "ok" },
      ],
      docs_updated: false,
      notes: "implemented",
    }),
    completed("claude", { findings: [] }),
  ];
  return async (input) => {
    calls.push(input);
    const next = outputs.shift();
    assert.ok(next, `unexpected runner call for ${input.phase}`);
    return next;
  };
}

function completed(provider: "claude" | "codex", structured: Record<string, unknown>) {
  return {
    status: "completed" as const,
    summary: "ok",
    structured,
    session:
      provider === "claude"
        ? { claudeSessionId: "claude-session" }
        : { codexSessionId: "codex-session" },
  };
}

function task(issue: number): TaskEntry {
  return createTaskEntry({
    issue,
    slug: `ak-${String(issue).padStart(3, "0")}`,
    title: `[AK-${String(issue).padStart(3, "0")}] production executor`,
    labels: ["agent-ready"],
    now: NOW,
  });
}

function writeTasks(root: string, tasks: TaskEntry[]): void {
  mkdirSync(join(root, ".autokit"), { recursive: true });
  writeFileSync(join(root, ".autokit", "audit-hmac-key"), "fixture-hmac-key", { mode: 0o600 });
  const tasksFile: TasksFile = { version: 1, generated_at: NOW, tasks };
  writeTasksFileAtomic(tasksPath(root), tasksFile);
}

function writeFastConfig(root: string): void {
  writeConfig(
    root,
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
runner_timeout:
  plan_ms: 111
  plan_verify_ms: 222
  implement_ms: 333
  review_ms: 444
  supervise_ms: 555
  default_ms: 666
`,
  );
}

function writeConfig(root: string, yaml: string): void {
  mkdirSync(join(root, ".autokit"), { recursive: true });
  writeFileSync(join(root, ".autokit", "config.yaml"), yaml, { mode: 0o600 });
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

function tasksPath(root: string): string {
  return join(root, ".autokit", "tasks.yaml");
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autokit-executor-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
