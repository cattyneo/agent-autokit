import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { type CliDeps, runCli } from "../../packages/cli/src/index.ts";
import {
  type AgentRunInput,
  loadTasksFile,
  type Provider,
  type TaskEntry,
} from "../../packages/core/src/index.ts";
import type { WorkflowRunner } from "../../packages/workflows/src/index.ts";

const NOW = "2026-05-08T03:00:00.000Z";
const ISSUE = 112;
const PR = 143;
const ISSUE_TITLE = "Happy path fixture";
const PRESETS = ["default", "laravel-filament", "next-shadcn", "docs-create"] as const;
type Preset = (typeof PRESETS)[number];
type ObservedCommand = { line: string; cwd?: string };

const PRESET_PROMPT_MARKERS: Record<Preset, { implement: string; review: string }> = {
  default: {
    implement: "general-purpose issue train task",
    review: "Review the pull request for correctness",
  },
  "laravel-filament": {
    implement: "Laravel / Filament codebase",
    review: "policies, validation, database changes",
  },
  "next-shadcn": {
    implement: "Next.js / shadcn/ui codebase",
    review: "route boundaries, server/client component splits",
  },
  "docs-create": {
    implement: "documentation-first task",
    review: "Review the documentation change",
  },
};

describe("v0.2 happy path E2E", () => {
  it("runs init -> preset apply -> add -> run -> merge -> cleanup for every bundled preset without live providers", async () => {
    for (const preset of PRESETS) {
      const repo = makeTempDir();
      const stateHome = makeTempDir();
      const commands: ObservedCommand[] = [];
      const runnerCalls: AgentRunInput[] = [];

      try {
        assert.equal(await runCli(["init"], makeCliHarness(repo, stateHome, commands).deps), 0);
        assert.equal(
          await runCli(["preset", "apply", preset], makeCliHarness(repo, stateHome, commands).deps),
          0,
          preset,
        );
        assert.equal(
          await runCli(
            ["add", String(ISSUE), "--label", "agent-ready", "-y"],
            makeCliHarness(repo, stateHome, commands).deps,
          ),
          0,
          preset,
        );

        const run = makeCliHarness(repo, stateHome, commands, {
          execFile: workflowExecFile(repo, commands),
          workflowRunner: happyPathRunner(runnerCalls),
          workflowMaxSteps: 20,
        });
        assert.equal(await runCli(["run"], run.deps), 0, preset);
        assert.match(run.stdout(), /#112\s+merged/, preset);

        const task = loadOnlyTask(repo);
        assert.equal(task.state, "merged", preset);
        assert.equal(task.failure, null, preset);
        assert.equal(task.runtime_phase, null, preset);
        assert.equal(task.pr.number, PR, preset);
        assert.equal(existsSync(join(repo, ".autokit", "worktrees", `issue-${ISSUE}`)), false);
        assert.equal(task.runtime.resolved_effort?.effort, "medium", preset);
        assert.equal(task.runtime.phase_self_correct_done, false, preset);

        assert.deepEqual(
          runnerCalls.map((call) => call.phase),
          ["plan", "plan_verify", "implement", "review"],
          preset,
        );
        assert.deepEqual(
          runnerCalls.map((call) => call.provider),
          ["claude", "codex", "codex", "claude"],
          preset,
        );
        assertPromptMarkers(preset, runnerCalls);

        const lines = commandLines(commands);
        assert.deepEqual(
          lines.filter((command) => /^(claude|codex)\b/.test(command)),
          [],
          preset,
        );
        assertCommandOrder(
          lines,
          `gh pr view ${PR} --json statusCheckRollup`,
          `gh pr merge ${PR} --auto --rebase --match-head-commit remote-head`,
          preset,
        );
        assertCommandOrder(
          lines,
          `gh pr merge ${PR} --auto --rebase --match-head-commit remote-head`,
          `gh pr view ${PR} --json state,mergedAt,headRefOid,mergeable,mergeStateStatus`,
          preset,
        );
        assertCommandOrder(
          lines,
          `gh pr view ${PR} --json state,mergedAt,headRefOid,mergeable,mergeStateStatus`,
          `git push origin --delete autokit/issue-${ISSUE}`,
          preset,
        );

        const auditKinds = readAuditKinds(repo);
        assertAuditSubsequence(auditKinds, ["preset_apply_started", "preset_apply_finished"]);
        assertAuditSubsequence(auditKinds, [
          "sanitize_pass_hmac",
          "phase_completed",
          "phase_completed",
          "phase_completed",
          "phase_started",
          "phase_completed",
          "auto_merge_reserved",
          "branch_deleted",
        ]);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(stateHome, { recursive: true, force: true });
      }
    }
  });

  it("fails closed before default provider dispatch when API-key env is present", async () => {
    const repo = makeTempDir();
    const stateHome = makeTempDir();
    const commands: ObservedCommand[] = [];

    try {
      assert.equal(await runCli(["init"], makeCliHarness(repo, stateHome, commands).deps), 0);
      assert.equal(
        await runCli(
          ["preset", "apply", "default"],
          makeCliHarness(repo, stateHome, commands).deps,
        ),
        0,
      );
      assert.equal(
        await runCli(
          ["add", String(ISSUE), "--label", "agent-ready", "-y"],
          makeCliHarness(repo, stateHome, commands).deps,
        ),
        0,
      );

      const run = makeCliHarness(repo, stateHome, commands, {
        env: { XDG_STATE_HOME: stateHome, ANTHROPIC_API_KEY: "test-key" },
        execFile: workflowExecFile(repo, commands),
        workflowMaxSteps: 4,
      });
      assert.notEqual(await runCli(["run"], run.deps), 0);
      assert.deepEqual(
        commandLines(commands).filter((command) => /^(claude|codex)\b/.test(command)),
        [],
      );

      const task = loadOnlyTask(repo);
      assert.equal(task.state, "queued");
      assert.equal(task.failure, null);
      assert.match(run.stderr(), /ANTHROPIC_API_KEY must not be exported/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateHome, { recursive: true, force: true });
    }
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autokit-happy-path-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCliHarness(
  cwd: string,
  stateHome: string,
  commands: ObservedCommand[],
  overrides: Partial<CliDeps> = {},
): { deps: CliDeps; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    deps: {
      cwd,
      env: { XDG_STATE_HOME: stateHome },
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
      execFile: baseExecFile(commands),
      now: () => NOW,
      ...overrides,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function baseExecFile(commands: ObservedCommand[]): NonNullable<CliDeps["execFile"]> {
  return (command, args, options) => {
    const line = `${command} ${args.join(" ")}`;
    commands.push({ line, cwd: options?.cwd });
    if (line === "git rev-parse --is-inside-work-tree" || line === "gh auth status") {
      return "ok";
    }
    if (line === `gh issue view ${ISSUE} --json number,title,state,labels`) {
      return JSON.stringify(issueMetadata());
    }
    throw new Error(`unexpected external command: ${line}`);
  };
}

function workflowExecFile(
  repo: string,
  commands: ObservedCommand[],
): NonNullable<CliDeps["execFile"]> {
  const worktree = join(repo, ".autokit", "worktrees", `issue-${ISSUE}`);
  const relativeWorktree = `.autokit/worktrees/issue-${ISSUE}`;
  const revParseResults = ["base-sha", "base-sha", "base-sha", "agent-sha", "commit-sha"];
  let revParseCalls = 0;
  let branch = `autokit/issue-${ISSUE}`;
  let prCreated = false;
  let remoteHead = "remote-head";
  let autoMergeReserved = false;
  let mergedObserved = false;
  let branchDeleted = false;

  return (command, args, options) => {
    const line = `${command} ${args.join(" ")}`;
    commands.push({ line, cwd: options?.cwd });
    if (command === "claude" || command === "codex") {
      throw new Error(`provider subprocess must not run: ${line}`);
    }
    if (line === "git rev-parse --is-inside-work-tree" || line === "gh auth status") {
      return "ok";
    }
    if (line === "git fetch origin main") {
      assert.equal(options?.cwd, repo, line);
      return "";
    }
    if (command === "git" && args[0] === "worktree" && args[1] === "add") {
      assert.equal(options?.cwd, repo, line);
      assert.deepEqual(args.slice(0, 3), ["worktree", "add", "-b"]);
      branch = args[3] ?? branch;
      assert.equal(args[4], worktree);
      assert.equal(args[5], "origin/main");
      mkdirSync(worktree, { recursive: true });
      return "";
    }
    if (line === `gh issue view ${ISSUE} --json number,title,state,labels`) {
      assert.equal(options?.cwd, repo, line);
      return JSON.stringify(issueMetadata());
    }
    if (line === `gh issue view ${ISSUE} --json number,title,body,labels,state,url`) {
      assert.equal(options?.cwd, repo, line);
      return JSON.stringify({
        ...issueMetadata(),
        body: "Issue #112 happy-path fixture",
        url: `https://github.com/cattyneo/agent-autokit/issues/${ISSUE}`,
      });
    }
    if (line === "git rev-parse HEAD") {
      assert.equal(options?.cwd, revParseCalls < 2 ? repo : worktree, line);
      revParseCalls += 1;
      return revParseResults.shift() ?? remoteHead;
    }
    if (
      line ===
      `gh pr list --head ${branch} --state all --json number,state,headRefOid,baseRefOid --limit 1`
    ) {
      assert.equal(options?.cwd, repo, line);
      return prCreated
        ? JSON.stringify([
            { number: PR, state: "OPEN", headRefOid: remoteHead, baseRefOid: "base-sha" },
          ])
        : "[]";
    }
    if (line === "git add -A") {
      assert.equal(options?.cwd, worktree, line);
      return "";
    }
    if (line === `git commit -m Implement issue #${ISSUE}`) {
      assert.equal(options?.cwd, worktree, line);
      return "";
    }
    if (line === `git push -u origin ${branch}`) {
      assert.equal(options?.cwd, worktree, line);
      remoteHead = "remote-head";
      return "";
    }
    if (line.startsWith("gh pr create --draft")) {
      assert.equal(options?.cwd, repo, line);
      prCreated = true;
      return `https://github.com/cattyneo/agent-autokit/pull/${PR}`;
    }
    if (line === `gh pr view ${PR} --json headRefOid,baseRefOid`) {
      assert.equal(options?.cwd, repo, line);
      return JSON.stringify({ headRefOid: remoteHead, baseRefOid: "base-sha" });
    }
    if (line === `gh pr ready ${PR}`) {
      assert.equal(options?.cwd, repo, line);
      return "";
    }
    if (line === `gh pr view ${PR} --json statusCheckRollup`) {
      assert.equal(options?.cwd, repo, line);
      return JSON.stringify({
        statusCheckRollup: [
          {
            name: "happy-path-e2e",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            detailsUrl: `https://github.com/cattyneo/agent-autokit/actions/runs/${PR}`,
          },
        ],
      });
    }
    if (line === `gh pr view ${PR} --json headRefOid,mergeable,mergeStateStatus,autoMergeRequest`) {
      assert.equal(options?.cwd, repo, line);
      return JSON.stringify({
        headRefOid: remoteHead,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        autoMergeRequest: null,
      });
    }
    if (line === `gh pr merge ${PR} --auto --rebase --match-head-commit ${remoteHead}`) {
      assert.equal(options?.cwd, repo, line);
      autoMergeReserved = true;
      return "";
    }
    if (line === `gh pr view ${PR} --json state,mergedAt,headRefOid,mergeable,mergeStateStatus`) {
      assert.equal(options?.cwd, repo, line);
      if (autoMergeReserved) {
        mergedObserved = true;
      }
      return JSON.stringify({
        state: mergedObserved ? "MERGED" : "OPEN",
        mergedAt: mergedObserved ? NOW : null,
        headRefOid: remoteHead,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      });
    }
    if (line === `git push origin --delete ${branch}`) {
      assert.equal(options?.cwd, repo, line);
      assert.equal(mergedObserved, true, "branch cleanup must wait for MERGED observation");
      branchDeleted = true;
      return "";
    }
    if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
      assert.equal(options?.cwd, repo, line);
      assert.equal(branchDeleted, true, "worktree cleanup must wait for branch deletion");
      assert.equal(args[2], relativeWorktree);
      rmSync(worktree, { recursive: true, force: true });
      return "";
    }
    throw new Error(`unexpected external command: ${line}`);
  };
}

function happyPathRunner(calls: AgentRunInput[]): WorkflowRunner {
  return async (input) => {
    calls.push(input);
    switch (input.phase) {
      case "plan":
        return completed(input.provider, {
          plan_markdown: "## Happy path plan\n\nRun init, preset, add, run, merge, cleanup.",
          assumptions: [],
          risks: [],
        });
      case "plan_verify":
        return completed(input.provider, { result: "ok", findings: [] });
      case "implement":
        return completed(input.provider, {
          changed_files: ["e2e/runners/happy-path.test.ts"],
          tests_run: [{ command: "bun test e2e/runners/happy-path.test.ts", result: "passed" }],
          docs_updated: false,
          notes: "happy path fixture",
        });
      case "review":
        return completed(input.provider, { findings: [] });
      default:
        throw new Error(`unexpected workflow phase: ${input.phase}`);
    }
  };
}

function completed(provider: Provider, structured: Record<string, unknown>) {
  return {
    status: "completed" as const,
    summary: "ok",
    structured,
    session:
      provider === "claude"
        ? { claudeSessionId: `claude-happy-${Object.keys(structured).sort().join("-")}` }
        : { codexSessionId: `codex-happy-${Object.keys(structured).sort().join("-")}` },
  };
}

function issueMetadata() {
  return {
    number: ISSUE,
    title: ISSUE_TITLE,
    state: "OPEN",
    labels: [{ name: "agent-ready" }, { name: "type:test" }, { name: "phase:e2e" }],
  };
}

function loadOnlyTask(repo: string): TaskEntry {
  const tasks = loadTasksFile(join(repo, ".autokit", "tasks.yaml")).tasks;
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  assert.ok(task);
  return task;
}

function readAuditKinds(repo: string): string[] {
  const logDir = join(repo, ".autokit", "logs");
  if (!existsSync(logDir)) {
    return [];
  }
  return readdirSync(logDir)
    .sort()
    .flatMap((entry) =>
      readFileSync(join(logDir, entry), "utf8")
        .trim()
        .split(/\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { kind?: string }),
    )
    .map((entry) => entry.kind)
    .filter((kind): kind is string => typeof kind === "string");
}

function assertAuditSubsequence(actual: string[], expected: string[]): void {
  let cursor = 0;
  for (const kind of actual) {
    if (kind === expected[cursor]) {
      cursor += 1;
    }
  }
  assert.equal(
    cursor,
    expected.length,
    `missing audit subsequence: ${expected.join(" -> ")} in ${actual.join(" -> ")}`,
  );
}

function commandLines(commands: ObservedCommand[]): string[] {
  return commands.map((command) => command.line);
}

function assertCommandOrder(lines: string[], before: string, after: string, context: string): void {
  const beforeIndex = lines.indexOf(before);
  const afterIndex = lines.indexOf(after);
  assert.ok(beforeIndex >= 0, `${context}: missing command ${before}`);
  assert.ok(afterIndex >= 0, `${context}: missing command ${after}`);
  assert.ok(beforeIndex < afterIndex, `${context}: expected ${before} before ${after}`);
}

function assertPromptMarkers(preset: Preset, calls: AgentRunInput[]): void {
  const markers = PRESET_PROMPT_MARKERS[preset];
  const implement = calls.find((call) => call.phase === "implement");
  const review = calls.find((call) => call.phase === "review");
  assert.ok(implement?.prompt.includes(markers.implement), `${preset}: implement prompt marker`);
  assert.ok(review?.prompt.includes(markers.review), `${preset}: review prompt marker`);
}
