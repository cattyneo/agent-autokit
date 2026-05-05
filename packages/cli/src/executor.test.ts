import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    assert.ok(commands.includes("gh pr merge 29 --auto --rebase --match-head-commit remote-head"));
    assert.ok(commands.includes("git push origin --delete autokit/issue-58"));
    assert.ok(commands.includes("git worktree remove .autokit/worktrees/issue-58"));
    assert.equal(loadTasksFile(tasksPath(root)).tasks[0].state, "merged");
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
    if (line === "gh pr view 29 --json headRefOid,mergeable,autoMergeRequest") {
      return JSON.stringify({
        headRefOid: "remote-head",
        mergeable: "MERGEABLE",
        autoMergeRequest: null,
      });
    }
    if (line === "gh pr view 29 --json state,mergedAt,headRefOid,mergeable") {
      return JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-05-05T01:00:00Z",
        headRefOid: "remote-head",
        mergeable: "MERGEABLE",
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
  const tasksFile: TasksFile = { version: 1, generated_at: NOW, tasks };
  writeTasksFileAtomic(tasksPath(root), tasksFile);
}

function writeFastConfig(root: string): void {
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
`,
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
