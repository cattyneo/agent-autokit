import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  type AgentRunInput,
  createTaskEntry,
  loadTasksFile,
  makeFailure,
  type TaskEntry,
  type TaskState,
  type TasksFile,
  writeTasksFileAtomic,
} from "@cattyneo/autokit-core";

import {
  type CliDeps,
  type ExecFile,
  getRetryExitCode,
  getWorkflowExitCode,
  type IssueMetadata,
  parseIssueRange,
  runCli,
  TEMPFAIL_EXIT_CODE,
} from "./index.ts";
import { INIT_MARKER_START, runInit } from "./init.ts";

const NOW = "2026-05-04T19:50:00+09:00";

describe("cli exit code contract", () => {
  it("prioritizes failed over paused/cleaning and returns tempfail for resumable states", () => {
    assert.equal(getWorkflowExitCode([]), 0);
    assert.equal(getWorkflowExitCode([task({ issue: 1, state: "merged" })]), 0);
    assert.equal(getWorkflowExitCode([task({ issue: 1, state: "queued" })]), TEMPFAIL_EXIT_CODE);
    assert.equal(getWorkflowExitCode([task({ issue: 1, state: "paused" })]), TEMPFAIL_EXIT_CODE);
    assert.equal(getWorkflowExitCode([task({ issue: 1, state: "cleaning" })]), TEMPFAIL_EXIT_CODE);
    assert.equal(
      getWorkflowExitCode([
        task({ issue: 1, state: "paused" }),
        task({ issue: 2, state: "failed" }),
      ]),
      1,
    );
  });

  it("uses retry-specific success when cleanup returns tasks to queued", () => {
    assert.equal(getRetryExitCode([task({ issue: 1, state: "queued" })]), 0);
    assert.equal(getRetryExitCode([task({ issue: 1, state: "paused" })]), TEMPFAIL_EXIT_CODE);
    assert.equal(getRetryExitCode([task({ issue: 1, state: "failed" })]), 1);
    assert.equal(getRetryExitCode([task({ issue: 1, state: "merged" })]), 1);
  });

  it("returns 2 for parser and argument validation errors", async () => {
    const harness = makeCliHarness();

    assert.equal(await runCli(["retry", "bad"], harness.deps), 2);
    assert.match(harness.stderr(), /invalid positive integer/);
  });
});

describe("cli task commands", () => {
  it("initializes assets transactionally and doctor validates prompt contracts", async () => {
    const root = makeTempDir();
    const init = runInit(root, { now: () => NOW });

    assert.equal(init.dryRun, false);
    assert.equal(existsSync(join(root, ".autokit", "tasks.yaml")), true);
    assert.equal(existsSync(join(root, ".autokit", "audit-hmac-key")), true);
    assert.equal(existsSync(join(root, ".agents", "prompts", "plan.md")), true);
    assert.equal(existsSync(join(root, ".agents", "skills", "autokit-question", "SKILL.md")), true);
    assert.match(
      readFileSync(join(root, ".agents", "skills", "autokit-question", "SKILL.md"), "utf8"),
      /^---\nname: autokit-question\n/m,
    );
    assert.equal(lstatSync(join(root, ".claude", "skills")).isSymbolicLink(), true);
    assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), new RegExp(INIT_MARKER_START));
    assert.equal(existsSync(join(root, ".autokit", ".backup")), false);

    const harness = makeCliHarness(root, { execFile: () => "ok" });
    assert.equal(await runCli(["doctor"], harness.deps), 0);
    assert.match(harness.stdout(), /PASS\tprompt contracts\tvalid/);
  });

  it("supports init --dry-run through the CLI seam without writing", async () => {
    const root = makeTempDir();
    const calls: unknown[] = [];
    const harness = makeCliHarness(root, {
      initProject: (input) => {
        calls.push(input);
        return { dryRun: input.dryRun === true, changed: [".agents/prompts/plan.md"], skipped: [] };
      },
    });

    assert.equal(await runCli(["init", "--dry-run"], harness.deps), 0);
    assert.deepEqual(calls, [{ dryRun: true, force: false }]);
    assert.match(harness.stdout(), /init dry-run/);
    assert.match(harness.stdout(), /change\t\.agents\/prompts\/plan\.md/);
  });

  it("rolls back staged init assets on injected failure", () => {
    const root = makeTempDir();

    assert.throws(() => runInit(root, { now: () => NOW, failAfterAssets: true }), /injected/);
    assert.equal(existsSync(join(root, ".agents")), false);
    assert.equal(existsSync(join(root, ".claude")), false);
    assert.equal(existsSync(join(root, ".autokit")), false);
  });

  it("aborts init for marker symlinks, parent symlinks, and backup blacklist conflicts", () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    symlinkSync(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
    assert.throws(() => runInit(root, { now: () => NOW }), /symlink_invalid: AGENTS\.md/);

    const parentSymlinkRoot = makeTempDir();
    symlinkSync(outside, join(parentSymlinkRoot, ".agents"));
    assert.throws(() => runInit(parentSymlinkRoot, { now: () => NOW }), /symlink_invalid/);

    const backupSymlinkRoot = makeTempDir();
    mkdirSync(join(backupSymlinkRoot, ".autokit"), { recursive: true });
    symlinkSync(outside, join(backupSymlinkRoot, ".autokit", ".backup"));
    assert.throws(() => runInit(backupSymlinkRoot, { now: () => NOW }), /symlink_invalid/);

    const providerDirRoot = makeTempDir();
    mkdirSync(join(providerDirRoot, ".claude", "skills"), { recursive: true });
    assert.throws(() => runInit(providerDirRoot, { now: () => NOW }), /symlink_invalid/);

    const danglingProviderRoot = makeTempDir();
    mkdirSync(join(danglingProviderRoot, ".claude"), { recursive: true });
    symlinkSync("missing", join(danglingProviderRoot, ".claude", "skills"));
    assert.throws(() => runInit(danglingProviderRoot, { now: () => NOW }), /symlink_invalid/);

    const blacklistRoot = makeTempDir();
    mkdirSync(join(blacklistRoot, ".codex"), { recursive: true });
    writeFileSync(join(blacklistRoot, ".codex", "auth.json"), "{}", { mode: 0o600 });
    assert.throws(() => runInit(blacklistRoot, { now: () => NOW }), /backup blacklist conflict/);
  });

  it("records rollback failure evidence without exposing backup contents", () => {
    const root = makeTempDir();

    assert.throws(
      () => runInit(root, { now: () => NOW, failAfterAssets: true, failDuringRollback: true }),
      /init rollback failed; backup retained at .autokit\/.backup/,
    );
    const audit = readFileSync(join(root, ".autokit", "init-audit.jsonl"), "utf8");
    assert.match(audit, /init_rollback_failed/);
    assert.equal(readdirSync(join(root, ".autokit", ".backup")).length, 1);
  });

  it("parses issue ranges with de-duplication and stable ordering", () => {
    assert.deepEqual(parseIssueRange("12,10-11,10"), [10, 11, 12]);
    assert.equal(parseIssueRange("all"), "all");
    assert.throws(() => parseIssueRange("12-10"), /invalid issue range/);
    assert.throws(() => parseIssueRange("0"), /invalid positive integer/);
    assert.throws(() => parseIssueRange("1-"), /invalid positive integer/);
  });

  it("adds labeled open issues with -y and writes tasks.yaml atomically", async () => {
    const root = makeTempDir();
    const issue: IssueMetadata = {
      number: 9,
      title: "[AK-008] cli doctor list cleanup",
      state: "OPEN",
      labels: ["agent-ready", "AK-008"],
    };
    const harness = makeCliHarness(root, {
      fetchIssue: (number) => (number === 9 ? issue : null),
      confirm: () => false,
    });

    const code = await runCli(["add", "9", "--label", "agent-ready", "-y"], harness.deps);

    assert.equal(code, 0);
    assert.match(harness.stdout(), /targets: 1, additions: 1/);
    const loaded = loadTasksFile(tasksPath(root));
    assert.equal(loaded.tasks[0].issue, 9);
    assert.equal(loaded.tasks[0].cached.title_at_add, issue.title);
    assert.equal(existsSync(`${tasksPath(root)}.tmp`), false);
  });

  it("continues add batch after active duplicates while preserving a non-zero exit", async () => {
    const root = makeTempDir();
    writeTasks(root, [task({ issue: 9, state: "queued" })]);
    const issues = new Map<number, IssueMetadata>([
      [9, { number: 9, title: "AK-009", state: "OPEN", labels: ["agent-ready"] }],
      [10, { number: 10, title: "AK-010", state: "OPEN", labels: ["agent-ready"] }],
    ]);
    const harness = makeCliHarness(root, {
      fetchIssue: (number) => issues.get(number) ?? null,
      confirm: () => false,
    });

    const code = await runCli(["add", "9-10", "-y"], harness.deps);

    assert.equal(code, 1);
    assert.match(harness.stderr(), /skip #9: task already active/);
    const loaded = loadTasksFile(tasksPath(root));
    assert.deepEqual(
      loaded.tasks.map((entry) => entry.issue),
      [9, 10],
    );
  });

  it("renders list --json and status without exposing issue body or PR diffs", async () => {
    const root = makeTempDir();
    writeTasks(root, [
      task({ issue: 9, state: "queued" }),
      task({ issue: 10, state: "implementing", runtimePhase: "implement" }),
    ]);
    const listHarness = makeCliHarness(root);

    assert.equal(await runCli(["list", "--json"], listHarness.deps), 0);
    const entries = JSON.parse(listHarness.stdout()) as Array<{ issue: number; state: TaskState }>;
    assert.deepEqual(
      entries.map((entry) => [entry.issue, entry.state]),
      [
        [9, "queued"],
        [10, "implementing"],
      ],
    );

    const statusHarness = makeCliHarness(root);
    assert.equal(await runCli(["status"], statusHarness.deps), 0);
    assert.deepEqual(JSON.parse(statusHarness.stdout()).issue, 10);
  });

  it("renders the run TUI frame and exits 75 for need_input prompts", async () => {
    const root = makeTempDir();
    writeTasks(root, [
      {
        ...task({ issue: 16, state: "paused", runtimePhase: "implement" }),
        failure: makeFailure({
          phase: "implement",
          code: "need_input_pending",
          message: "Use vitest?",
          ts: NOW,
        }),
      },
    ]);
    const harness = makeCliHarness(root);

    assert.equal(await runCli(["-y", "run"], harness.deps), TEMPFAIL_EXIT_CODE);
    assert.match(harness.stdout(), /Progress/);
    assert.match(
      harness.stdout(),
      /#16 paused implement PR - AK-016 need_input_pending: Use vitest\?/,
    );
    assert.match(harness.stdout(), /-y cannot answer without an active runner question payload/);
  });

  it("passes -y default answers to the active workflow question hook", async () => {
    const paused = {
      ...task({ issue: 16, state: "paused", runtimePhase: "implement" }),
      title: "[AK-015] tui-question-monitoring",
    };
    const answered: string[] = [];
    const harness = makeCliHarness(undefined, {
      runWorkflow: async ({ yes, answerQuestion }) => {
        assert.equal(yes, true);
        answered.push(
          await answerQuestion({
            task: paused,
            phase: "implement",
            question: { text: "Use vitest?", default: "vitest" },
            turn: 0,
          }),
        );
        return [{ ...paused, state: "merged", runtime_phase: null }];
      },
    });

    assert.equal(await runCli(["-y", "run"], harness.deps), 0);
    assert.deepEqual(answered, ["vitest"]);
    assert.match(harness.stdout(), /auto-answered need_input with default for #16/);
    assert.match(harness.stdout(), /#16 merged - PR - \[AK-015\] tui-question-monitoring/);
  });

  it("uses the production workflow runner when no test seam is injected", async () => {
    const root = makeTempDir();
    writeTasks(root, [task({ issue: 9, state: "queued" })]);
    const calls: AgentRunInput[] = [];
    const harness = makeCliHarness(root, {
      workflowMaxSteps: 1,
      workflowRunner: async (input) => {
        calls.push(input);
        if (input.phase === "plan_verify") {
          return {
            status: "completed",
            summary: "verified",
            structured: { result: "ok", findings: [] },
          };
        }
        return {
          status: "completed",
          summary: "planned",
          structured: { plan_markdown: "## Plan", assumptions: [], risks: [] },
        };
      },
      execFile: (command, args) => {
        assert.deepEqual(
          [command, ...args],
          ["gh", "issue", "view", "9", "--json", "number,title,body,labels,state,url"],
        );
        return JSON.stringify({ number: 9, title: "AK-009", body: "Issue body" });
      },
    });

    assert.equal(await runCli(["run"], harness.deps), TEMPFAIL_EXIT_CODE);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].phase, "plan");
    assert.equal(calls[0].provider, "claude");
    assert.equal(calls[1].phase, "plan_verify");
    assert.equal(calls[1].provider, "codex");
    assert.match(calls[0].prompt, /Issue context JSON:/);
    assert.match(calls[0].prompt, /Issue body/);
    const loaded = loadTasksFile(tasksPath(root)).tasks[0];
    assert.equal(loaded.state, "planned");
    assert.equal(loaded.runtime_phase, null);
  });

  it("fails production run before runner dispatch when API key env is exported", async () => {
    const root = makeTempDir();
    writeTasks(root, [task({ issue: 9, state: "queued" })]);
    const calls: AgentRunInput[] = [];
    const harness = makeCliHarness(root, {
      env: { OPENAI_API_KEY: "dummy" },
      workflowRunner: async (input) => {
        calls.push(input);
        return { status: "completed", summary: "unexpected" };
      },
    });

    assert.equal(await runCli(["run"], harness.deps), 1);
    assert.match(harness.stderr(), /OPENAI_API_KEY must not be exported/);
    assert.equal(calls.length, 0);
  });

  it("rejects resume of retry_cleanup_failed paused tasks with tempfail", async () => {
    const root = makeTempDir();
    writeTasks(root, [
      {
        ...task({ issue: 9, state: "paused" }),
        failure: makeFailure({
          phase: "retry",
          code: "retry_cleanup_failed",
          message: "busy worktree",
          ts: NOW,
        }),
      },
    ]);
    const harness = makeCliHarness(root);

    assert.equal(await runCli(["resume", "9"], harness.deps), TEMPFAIL_EXIT_CODE);
    assert.match(harness.stderr(), /autokit retry/);
  });

  it("rejects resume of an explicit issue that is missing or not paused", async () => {
    const root = makeTempDir();
    writeTasks(root, [task({ issue: 9, state: "queued" })]);
    const notPausedHarness = makeCliHarness(root);

    assert.equal(await runCli(["resume", "9"], notPausedHarness.deps), 1);
    assert.match(notPausedHarness.stderr(), /issue #9 is not paused/);

    const missingHarness = makeCliHarness(root);
    assert.equal(await runCli(["resume", "99"], missingHarness.deps), 1);
    assert.match(missingHarness.stderr(), /issue #99 not found/);
  });
});

describe("cli doctor/retry/cleanup gates", () => {
  it("fails doctor when API key env is exported and warns on missing config only", async () => {
    const root = makeTempDir();
    const okExec: ExecFile = () => "ok";
    const passHarness = makeCliHarness(root, { execFile: okExec });

    assert.equal(await runCli(["doctor"], passHarness.deps), 0);
    assert.match(passHarness.stdout(), /WARN\tconfig\t\.autokit\/config\.yaml not found/);

    const failHarness = makeCliHarness(root, {
      env: { ANTHROPIC_API_KEY: "dummy", CODEX_API_KEY: "dummy" },
      execFile: okExec,
    });

    assert.equal(await runCli(["doctor"], failHarness.deps), 1);
    assert.match(
      failHarness.stdout(),
      /FAIL\tenv unset\tANTHROPIC_API_KEY,CODEX_API_KEY must not be exported/,
    );
  });

  it("recovers a corrupt queue from tasks.yaml.bak for retry --recover-corruption", async () => {
    const root = makeTempDir();
    writeTasks(root, [task({ issue: 9, state: "paused" })]);
    const backup = readFileSync(tasksPath(root), "utf8");
    writeFileSync(`${tasksPath(root)}.bak`, backup, { mode: 0o600 });
    writeFileSync(tasksPath(root), "version: [", { mode: 0o600 });
    const harness = makeCliHarness(root);

    assert.equal(await runCli(["retry", "--recover-corruption", "9"], harness.deps), 0);
    assert.match(harness.stdout(), /recover-corruption target: #9/);
    assert.equal(loadTasksFile(tasksPath(root)).tasks[0].issue, 9);
  });

  it("retries retry_cleanup_failed paused tasks when retry has no explicit range", async () => {
    const root = makeTempDir();
    writeTasks(root, [retryCleanupPausedTask(9)]);
    const calls: string[] = [];
    const harness = makeCliHarness(root, {
      execFile: (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        return "";
      },
    });

    assert.equal(await runCli(["retry"], harness.deps), 0);
    const loaded = loadTasksFile(tasksPath(root)).tasks[0];
    assert.equal(loaded.state, "queued");
    assert.equal(loaded.pr.number, null);
    assert.deepEqual(calls, [
      "gh pr close 29 --delete-branch --comment autokit retry: superseded",
      "git worktree remove --force .autokit/worktrees/issue-9",
      "git branch -D autokit/issue-9",
    ]);
  });

  it("verifies merged PR head before cleanup --force-detach can mark a task merged", async () => {
    const root = makeTempDir();
    writeTasks(root, [forceDetachTask({ issue: 9, state: "cleaning" })]);
    const harness = makeCliHarness(root, {
      execFile: () =>
        JSON.stringify({
          state: "MERGED",
          mergedAt: "2026-05-04T10:00:00Z",
          headRefOid: "head-9",
          mergeable: "UNKNOWN",
        }),
      confirm: () => true,
    });

    assert.equal(await runCli(["cleanup", "--force-detach", "9"], harness.deps), 0);
    const loaded = loadTasksFile(tasksPath(root)).tasks[0];
    assert.equal(loaded.state, "merged");
    assert.equal(loaded.cleaning_progress.worktree_remove_attempts, 0);
  });

  it("supports cleanup --force-detach --dry-run without mutating state", async () => {
    const root = makeTempDir();
    writeTasks(root, [forceDetachTask({ issue: 9, state: "cleaning" })]);
    const harness = makeCliHarness(root, {
      execFile: () =>
        JSON.stringify({
          state: "MERGED",
          mergedAt: "2026-05-04T10:00:00Z",
          headRefOid: "head-9",
          mergeable: "UNKNOWN",
        }),
      confirm: () => false,
    });

    assert.equal(await runCli(["cleanup", "--force-detach", "9", "--dry-run"], harness.deps), 0);
    assert.equal(loadTasksFile(tasksPath(root)).tasks[0].state, "cleaning");
  });

  it("does not persist force-detach precondition failures during dry-run", async () => {
    const root = makeTempDir();
    writeTasks(root, [forceDetachTask({ issue: 9, state: "cleaning" })]);
    const harness = makeCliHarness(root, {
      execFile: () =>
        JSON.stringify({
          state: "OPEN",
          mergedAt: null,
          headRefOid: "head-9",
          mergeable: "MERGEABLE",
        }),
    });

    assert.equal(await runCli(["cleanup", "--force-detach", "9", "--dry-run"], harness.deps), 1);
    const loaded = loadTasksFile(tasksPath(root)).tasks[0];
    assert.equal(loaded.state, "cleaning");
    assert.equal(loaded.failure, null);
  });

  it("pauses cleanup --force-detach on OPEN PR or head mismatch instead of forcing merged", async () => {
    const root = makeTempDir();
    writeTasks(root, [forceDetachTask({ issue: 9, state: "cleaning" })]);
    const harness = makeCliHarness(root, {
      execFile: () =>
        JSON.stringify({
          state: "OPEN",
          mergedAt: null,
          headRefOid: "head-9",
          mergeable: "MERGEABLE",
        }),
    });

    assert.equal(await runCli(["cleanup", "--force-detach", "9"], harness.deps), 1);
    const loaded = loadTasksFile(tasksPath(root)).tasks[0];
    assert.equal(loaded.state, "paused");
    assert.equal(loaded.failure?.code, "merge_sha_mismatch");
  });
});

type TaskOptions = {
  issue: number;
  state: TaskState;
  runtimePhase?: TaskEntry["runtime_phase"];
};

function task(options: TaskOptions): TaskEntry {
  return {
    ...createTaskEntry({
      issue: options.issue,
      slug: `ak-${String(options.issue).padStart(3, "0")}`,
      title: `AK-${String(options.issue).padStart(3, "0")}`,
      labels: ["agent-ready"],
      now: NOW,
    }),
    state: options.state,
    runtime_phase: options.runtimePhase ?? null,
    failure:
      options.state === "failed"
        ? makeFailure({ phase: "review", code: "review_max", message: "max", ts: NOW })
        : null,
    timestamps: {
      added_at: NOW,
      started_at: options.state === "queued" ? null : NOW,
      completed_at: options.state === "merged" ? NOW : null,
    },
  };
}

function forceDetachTask(options: { issue: number; state: "cleaning" | "paused" }): TaskEntry {
  return {
    ...task({ issue: options.issue, state: options.state }),
    pr: {
      number: options.issue + 20,
      head_sha: `head-${options.issue}`,
      base_sha: "base",
      created_at: NOW,
    },
    branch: `autokit/issue-${options.issue}`,
    worktree_path: `.autokit/worktrees/issue-${options.issue}`,
    failure:
      options.state === "paused"
        ? makeFailure({
            phase: "cleanup",
            code: "worktree_remove_failed",
            message: "busy",
            ts: NOW,
          })
        : null,
  };
}

function retryCleanupPausedTask(issue: number): TaskEntry {
  return {
    ...forceDetachTask({ issue, state: "paused" }),
    failure: makeFailure({
      phase: "retry",
      code: "retry_cleanup_failed",
      message: "busy",
      ts: NOW,
    }),
  };
}

function makeCliHarness(
  root = makeTempDir(),
  overrides: Partial<Omit<CliDeps, "cwd" | "stdout" | "stderr">> = {},
): { deps: CliDeps; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    deps: {
      cwd: root,
      env: {},
      now: () => NOW,
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
      execFile: (command, args) => {
        throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
      },
      ...overrides,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function writeTasks(root: string, tasks: TaskEntry[]): void {
  mkdirSync(join(root, ".autokit"), { recursive: true });
  writeFileSync(join(root, ".autokit", "audit-hmac-key"), "fixture-hmac-key", { mode: 0o600 });
  const tasksFile: TasksFile = { version: 1, generated_at: NOW, tasks };
  writeTasksFileAtomic(tasksPath(root), tasksFile);
}

function tasksPath(root: string): string {
  return join(root, ".autokit", "tasks.yaml");
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autokit-cli-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}
