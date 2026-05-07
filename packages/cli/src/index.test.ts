import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  type AgentRunInput,
  createTaskEntry,
  DEFAULT_CONFIG,
  loadTasksFile,
  makeFailure,
  parseConfigYaml,
  type TaskEntry,
  type TaskState,
  type TasksFile,
  tryAcquireRunLock,
  writeTasksFileAtomic,
} from "@cattyneo/autokit-core";

import {
  type CliDeps,
  type ExecFile,
  getRetryExitCode,
  getWorkflowExitCode,
  type IssueMetadata,
  type PhaseOverrideInput,
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

  it("starts the local serve API through the CLI seam", async () => {
    const root = makeTempDir();
    const calls: unknown[] = [];
    let closed = false;
    const signals = new Map<string, () => void>();
    const exits: number[] = [];
    const harness = makeCliHarness(root, {
      startServe: async (input) => {
        calls.push({
          repoRoot: input.repoRoot,
          host: input.host,
          port: input.port,
          hasWorkflow: typeof input.runWorkflow === "function",
        });
        return {
          host: input.host ?? "127.0.0.1",
          port: 49152,
          tokenPath: "/tmp/token",
          close: async () => {
            closed = true;
          },
        };
      },
      proc: {
        once: (event: string | symbol, listener: (...args: unknown[]) => void) => {
          signals.set(String(event), listener as () => void);
          return process;
        },
        exit: (code) => {
          exits.push(Number(code ?? 0));
          return undefined as never;
        },
      },
    });

    assert.equal(await runCli(["serve", "--port", "0"], harness.deps), 0);
    assert.deepEqual(calls, [{ repoRoot: root, host: "127.0.0.1", port: 0, hasWorkflow: true }]);
    assert.match(harness.stdout(), /serve listening\thttp:\/\/127\.0\.0\.1:49152/);
    assert.match(harness.stdout(), /token file\t\/tmp\/token/);
    signals.get("SIGTERM")?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, true);
    assert.deepEqual(exits, [0]);
  });

  it("routes serve workflow operations through CLI command semantics", async () => {
    const root = makeTempDir();
    const paused = task({ issue: 9, state: "paused" });
    paused.runtime.previous_state = "queued";
    writeTasks(root, [
      paused,
      retryCleanupPausedTask(10),
      forceDetachTask({ issue: 11, state: "cleaning" }),
    ]);
    const execs: string[] = [];
    const harness = makeCliHarness(root, {
      workflowMaxSteps: 0,
      execFile: (command, args) => {
        execs.push(`${command} ${args.join(" ")}`);
        if (command === "gh" && args[0] === "pr" && args[1] === "view") {
          return JSON.stringify({
            state: "MERGED",
            merged: true,
            headRefOid: "head-11",
            mergedAt: "2026-05-04T10:00:00Z",
          });
        }
        return "";
      },
      startServe: async (input) => {
        await input.runWorkflow({
          repoRoot: root,
          operation: "resume",
          issue: 9,
          run_id: "run-resume",
        });
        await input.runWorkflow({
          repoRoot: root,
          operation: "retry",
          issue: 10,
          run_id: "run-retry",
        });
        await input.runWorkflow({
          repoRoot: root,
          operation: "cleanup",
          issue: 11,
          merged_only: true,
          run_id: "run-cleanup",
        });
        return {
          host: input.host ?? "127.0.0.1",
          port: 49152,
          tokenPath: "/tmp/token",
          close: async () => {},
        };
      },
    });

    assert.equal(await runCli(["serve", "--port", "0"], harness.deps), 0);
    const loaded = loadTasksFile(tasksPath(root)).tasks;
    assert.equal(loaded.find((entry) => entry.issue === 9)?.state, "queued");
    assert.equal(loaded.find((entry) => entry.issue === 10)?.state, "queued");
    assert.equal(loaded.find((entry) => entry.issue === 11)?.state, "merged");
    assert.ok(execs.some((entry) => entry.startsWith("gh pr view 31")));
  });

  it("bridges production workflow events and audit operations to serve workflow hooks", async () => {
    const root = makeTempDir();
    writeTasks(root, [task({ issue: 9, state: "queued" })]);
    const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const audits: Array<{ kind: string; fields: Record<string, unknown> }> = [];
    const runnerCalls: AgentRunInput[] = [];
    const harness = makeCliHarness(root, {
      workflowMaxSteps: 1,
      workflowRunner: async (input) => {
        runnerCalls.push(input);
        input.onStdout?.(
          '{"status":"completed","data":{"summary":"plain-prompt-secret"},"api_key":"credential-json-literal"}',
        );
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
        if (command === "git" && args.join(" ") === "rev-parse HEAD") {
          return "head-sha";
        }
        assert.deepEqual(
          [command, ...args],
          ["gh", "issue", "view", "9", "--json", "number,title,body,labels,state,url"],
        );
        return JSON.stringify({ number: 9, title: "AK-009", body: "Issue body" });
      },
      startServe: async (input) => {
        await input.runWorkflow({
          repoRoot: root,
          operation: "run",
          issue: 9,
          run_id: "run-serve",
          emitEvent: (event) => {
            events.push(event);
            return String(events.length);
          },
          auditOperation: (kind, fields) => {
            audits.push({ kind, fields });
          },
        });
        return {
          host: input.host ?? "127.0.0.1",
          port: 49152,
          tokenPath: "/tmp/token",
          close: async () => {},
        };
      },
    });

    assert.equal(await runCli(["serve", "--port", "0"], harness.deps), 0);
    assert.deepEqual(
      runnerCalls.map((call) => call.phase),
      ["plan", "plan_verify"],
    );
    assert.ok(
      events.some((event) => event.kind === "phase_started" && event.data.phase === "plan"),
    );
    assert.ok(
      events.some(
        (event) =>
          event.kind === "runner_stdout" &&
          String(event.data.chunk).includes("credential-json-literal"),
      ),
    );
    assert.ok(
      audits.some(
        (audit) => audit.kind === "phase_completed" && audit.fields.phase === "plan_verify",
      ),
    );
  });
});

describe("cli task commands", () => {
  it("initializes assets transactionally and doctor validates prompt contracts", async () => {
    const root = makeTempDir();
    const init = runInit(root, { now: () => NOW });

    assert.equal(init.dryRun, false);
    assert.equal(existsSync(join(root, ".autokit", "tasks.yaml")), true);
    assert.equal(
      readFileSync(join(root, ".autokit", ".gitignore"), "utf8"),
      "*\n!.gitignore\n!config.yaml\n",
    );
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
    assert.deepEqual(
      parseConfigYaml(readFileSync(join(root, ".autokit", "config.yaml"), "utf8")),
      DEFAULT_CONFIG,
    );

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

  it("prunes expired init backup residue before enforcing the force gate", () => {
    const expiredRoot = makeTempDir();
    const expired = join(expiredRoot, ".autokit", ".backup", "expired");
    mkdirSync(expired, { recursive: true });
    utimesSync(expired, new Date("2026-03-01T00:00:00.000Z"), new Date("2026-03-01T00:00:00.000Z"));

    assert.doesNotThrow(() => runInit(expiredRoot, { now: () => NOW }));
    assert.equal(existsSync(join(expiredRoot, ".autokit", ".backup")), false);

    const recentRoot = makeTempDir();
    mkdirSync(join(recentRoot, ".autokit", ".backup", "recent"), { recursive: true });
    assert.throws(() => runInit(recentRoot, { now: () => NOW }), /existing init backup/);
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

  it("validates run phase/provider/effort override before dispatch", async () => {
    const root = makeTempDir();
    let phaseOverride: PhaseOverrideInput | undefined;
    const harness = makeCliHarness(root, {
      runWorkflow: async (input) => {
        phaseOverride = input.phaseOverride;
        return [{ ...task({ issue: 94, state: "merged" }), runtime_phase: null }];
      },
    });

    assert.equal(
      await runCli(
        ["run", "--phase", "plan", "--provider", "codex", "--effort", "high"],
        harness.deps,
      ),
      0,
    );
    assert.deepEqual(phaseOverride, { phase: "plan", provider: "codex", effort: "high" });
  });

  it("fails closed on invalid run override combinations before dispatch", async () => {
    const root = makeTempDir();
    let dispatched = false;
    const harness = makeCliHarness(root, {
      runWorkflow: async () => {
        dispatched = true;
        return [];
      },
    });

    assert.equal(
      await runCli(["run", "--phase", "ci_wait", "--provider", "codex"], harness.deps),
      2,
    );
    assert.equal(await runCli(["run", "--provider", "codex"], harness.deps), 2);
    assert.equal(await runCli(["run", "--phase", "plan", "--effort", "xhigh"], harness.deps), 2);
    assert.equal(
      await runCli(["run", "--phase", "plan", "--provider", "unknown"], harness.deps),
      2,
    );
    assert.equal(dispatched, false);
    assert.match(harness.stderr(), /unsupported override phase: ci_wait/);
    assert.match(harness.stderr(), /--provider and --effort require --phase/);
    assert.match(harness.stderr(), /unsupported override effort: xhigh/);
    assert.match(harness.stderr(), /unsupported override provider: unknown/);
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
        if (command === "git" && args.join(" ") === "rev-parse HEAD") {
          return "head-sha";
        }
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

  it("loads all legacy session fixtures through the CLI resume parse gate", async () => {
    const fixtureRoot = join(process.cwd(), "e2e", "fixtures", "legacy-tasks-yaml");
    for (const file of readdirSync(fixtureRoot).filter((entry) => entry.endsWith(".yaml"))) {
      const fixture = parseLegacySessionFixture(readFileSync(join(fixtureRoot, file), "utf8"));
      const root = makeTempDir();
      mkdirSync(join(root, ".autokit"), { recursive: true });
      const legacyTask = structuredClone(
        task({ issue: 88, state: "paused", runtimePhase: fixture.phase }),
      ) as unknown as Record<string, unknown>;
      const runtime = legacyTask.runtime as Record<string, unknown>;
      delete runtime.resolved_effort;
      delete runtime.phase_self_correct_done;
      delete runtime.phase_override;
      legacyTask.provider_sessions = fixture.provider_sessions;
      writeFileSync(
        tasksPath(root),
        JSON.stringify({ version: 1, generated_at: NOW, tasks: [legacyTask] }),
        { mode: 0o600 },
      );
      const harness = makeCliHarness(root);

      assert.equal(await runCli(["resume", "88"], harness.deps), TEMPFAIL_EXIT_CODE, file);
      const loaded = loadTasksFile(tasksPath(root)).tasks[0];
      assert.equal(
        loaded.provider_sessions[fixture.phase].last_provider,
        fixture.expected_last_provider,
        file,
      );
      assert.equal(loaded.runtime.resolved_effort, null, file);
      assert.equal(loaded.runtime.phase_self_correct_done, null, file);
      assert.equal(loaded.runtime.phase_override, null, file);
    }
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

  it("fast-fails write commands when the process lock is busy without mutating state", async () => {
    const initRoot = makeTempDir();
    createBusyLock(initRoot);
    const initHarness = makeCliHarness(initRoot, { execFile: () => "ok" });
    assert.equal(await runCli(["init"], initHarness.deps), TEMPFAIL_EXIT_CODE);
    assert.match(initHarness.stderr(), /autokit lock busy/);
    assert.equal(existsSync(join(initRoot, ".autokit", "config.yaml")), false);

    const addRoot = makeTempDir();
    createBusyLock(addRoot);
    let fetched = false;
    const addHarness = makeCliHarness(addRoot, {
      fetchIssue: () => {
        fetched = true;
        return { number: 9, title: "AK-009", state: "OPEN", labels: ["agent-ready"] };
      },
    });
    assert.equal(await runCli(["add", "9", "-y"], addHarness.deps), TEMPFAIL_EXIT_CODE);
    assert.equal(fetched, false);
    assert.equal(existsSync(tasksPath(addRoot)), false);

    const runRoot = makeTempDir();
    writeTasks(runRoot, [task({ issue: 9, state: "queued" })]);
    const runBefore = readFileSync(tasksPath(runRoot), "utf8");
    createBusyLock(runRoot);
    let dispatched = false;
    const runHarness = makeCliHarness(runRoot, {
      runWorkflow: async () => {
        dispatched = true;
        return [];
      },
    });
    assert.equal(await runCli(["run"], runHarness.deps), TEMPFAIL_EXIT_CODE);
    assert.equal(dispatched, false);
    assert.equal(readFileSync(tasksPath(runRoot), "utf8"), runBefore);

    const resumeRoot = makeTempDir();
    writeTasks(resumeRoot, [task({ issue: 9, state: "paused" })]);
    const resumeBefore = readFileSync(tasksPath(resumeRoot), "utf8");
    createBusyLock(resumeRoot);
    const resumeHarness = makeCliHarness(resumeRoot);
    assert.equal(await runCli(["resume", "9"], resumeHarness.deps), TEMPFAIL_EXIT_CODE);
    assert.equal(readFileSync(tasksPath(resumeRoot), "utf8"), resumeBefore);

    const resumeMissingRoot = makeTempDir();
    writeTasks(resumeMissingRoot, [task({ issue: 10, state: "paused" })]);
    createBusyLock(resumeMissingRoot);
    const resumeMissingHarness = makeCliHarness(resumeMissingRoot);
    assert.equal(await runCli(["resume", "9"], resumeMissingHarness.deps), TEMPFAIL_EXIT_CODE);
    assert.doesNotMatch(resumeMissingHarness.stderr(), /not found/);

    const resumeNotPausedRoot = makeTempDir();
    writeTasks(resumeNotPausedRoot, [task({ issue: 9, state: "queued" })]);
    createBusyLock(resumeNotPausedRoot);
    const resumeNotPausedHarness = makeCliHarness(resumeNotPausedRoot);
    assert.equal(await runCli(["resume", "9"], resumeNotPausedHarness.deps), TEMPFAIL_EXIT_CODE);
    assert.doesNotMatch(resumeNotPausedHarness.stderr(), /not paused/);

    const retryRoot = makeTempDir();
    writeTasks(retryRoot, [retryCleanupPausedTask(9)]);
    const retryBefore = readFileSync(tasksPath(retryRoot), "utf8");
    createBusyLock(retryRoot);
    const retryHarness = makeCliHarness(retryRoot, {
      execFile: () => {
        throw new Error("unexpected retry side effect");
      },
    });
    assert.equal(await runCli(["retry"], retryHarness.deps), TEMPFAIL_EXIT_CODE);
    assert.equal(readFileSync(tasksPath(retryRoot), "utf8"), retryBefore);

    const cleanupRoot = makeTempDir();
    writeTasks(cleanupRoot, [forceDetachTask({ issue: 9, state: "cleaning" })]);
    const cleanupBefore = readFileSync(tasksPath(cleanupRoot), "utf8");
    createBusyLock(cleanupRoot);
    const cleanupHarness = makeCliHarness(cleanupRoot, {
      execFile: () => {
        throw new Error("unexpected cleanup side effect");
      },
    });
    assert.equal(
      await runCli(["cleanup", "--force-detach", "9"], cleanupHarness.deps),
      TEMPFAIL_EXIT_CODE,
    );
    assert.equal(readFileSync(tasksPath(cleanupRoot), "utf8"), cleanupBefore);
  });

  it("reports lock release failures instead of treating the command as successful", async () => {
    const root = makeTempDir();
    const harness = makeCliHarness(root, {
      initProject: () => {
        writeFileSync(join(root, ".autokit", ".lock", "sidecar"), "unexpected", { mode: 0o600 });
        return { changed: [], skipped: [], dryRun: false };
      },
    });

    assert.equal(await runCli(["init"], harness.deps), 1);
    assert.match(harness.stderr(), /autokit lock release failed/);
    assert.equal(existsSync(join(root, ".autokit", ".lock", "sidecar")), true);
  });

  it("redacts lock holder host when config parsing fails after host_redact was requested", async () => {
    const root = makeTempDir();
    writeConfig(
      root,
      `
version: 1
serve:
  lock:
    host_redact: true
unknown_config_key: true
`,
    );
    let holderHost = "";
    const harness = makeCliHarness(root, {
      initProject: () => {
        holderHost = JSON.parse(
          readFileSync(join(root, ".autokit", ".lock", "holder.json"), "utf8"),
        ).host;
        return { changed: [], skipped: [], dryRun: false };
      },
    });

    assert.equal(await runCli(["init"], harness.deps), 0);
    assert.match(holderHost, /^[a-f0-9]{16}$/);
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
    writeAutokitGitignore(root);
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

  it("warns when deprecated Claude allowed_tools is present in config", async () => {
    const root = makeTempDir();
    writeAutokitGitignore(root);
    mkdirSync(join(root, ".autokit"), { recursive: true });
    writeFileSync(
      join(root, ".autokit", "config.yaml"),
      'version: 1\npermissions:\n  claude:\n    allowed_tools: ["Read"]\n',
    );
    const harness = makeCliHarness(root, { execFile: () => "ok" });

    assert.equal(await runCli(["doctor"], harness.deps), 0);
    assert.match(
      harness.stdout(),
      /WARN\tconfig\tpermissions\.claude\.allowed_tools is deprecated/,
    );
  });

  it("fails doctor when .autokit/.gitignore is missing or does not protect state", async () => {
    const missingRoot = makeTempDir();
    const missingHarness = makeCliHarness(missingRoot, { execFile: () => "ok" });

    assert.equal(await runCli(["doctor"], missingHarness.deps), 1);
    assert.match(missingHarness.stdout(), /FAIL\t.autokit gitignore\t.autokit\/.gitignore missing/);

    const wrongRoot = makeTempDir();
    mkdirSync(join(wrongRoot, ".autokit"), { recursive: true });
    writeFileSync(join(wrongRoot, ".autokit", ".gitignore"), "!config.yaml\n", { mode: 0o600 });
    const wrongHarness = makeCliHarness(wrongRoot, { execFile: () => "ok" });

    assert.equal(await runCli(["doctor"], wrongHarness.deps), 1);
    assert.match(wrongHarness.stdout(), /FAIL\t.autokit gitignore\tmust contain/);

    const extraRoot = makeTempDir();
    mkdirSync(join(extraRoot, ".autokit"), { recursive: true });
    writeFileSync(
      join(extraRoot, ".autokit", ".gitignore"),
      "*\n!.gitignore\n!config.yaml\n!tasks.yaml\n!.lock/\n!.lock/holder.json\n",
      { mode: 0o600 },
    );
    const extraHarness = makeCliHarness(extraRoot, { execFile: () => "ok" });

    assert.equal(await runCli(["doctor"], extraHarness.deps), 1);
    assert.match(extraHarness.stdout(), /FAIL\t.autokit gitignore\tmust not contain extra rules/);
  });

  it("fails doctor when .autokit lock modes expose holder metadata", async () => {
    const dirRoot = makeTempDir();
    writeAutokitGitignore(dirRoot);
    mkdirSync(join(dirRoot, ".autokit", ".lock"), { recursive: true, mode: 0o755 });
    chmodSync(join(dirRoot, ".autokit", ".lock"), 0o755);
    const dirHarness = makeCliHarness(dirRoot, { execFile: () => "ok" });

    assert.equal(await runCli(["doctor"], dirHarness.deps), 1);
    assert.match(
      dirHarness.stdout(),
      /FAIL\t.autokit lock mode\t.autokit\/.lock must be mode 0700/,
    );

    const holderRoot = makeTempDir();
    writeAutokitGitignore(holderRoot);
    mkdirSync(join(holderRoot, ".autokit", ".lock"), { recursive: true, mode: 0o700 });
    chmodSync(join(holderRoot, ".autokit", ".lock"), 0o700);
    writeFileSync(join(holderRoot, ".autokit", ".lock", "holder.json"), "{}", { mode: 0o644 });
    chmodSync(join(holderRoot, ".autokit", ".lock", "holder.json"), 0o644);
    const holderHarness = makeCliHarness(holderRoot, { execFile: () => "ok" });

    assert.equal(await runCli(["doctor"], holderHarness.deps), 1);
    assert.match(
      holderHarness.stdout(),
      /FAIL\t.autokit lock mode\t.autokit\/.lock\/holder.json must be mode 0600/,
    );
  });

  it("fails doctor on stale phase overrides and explicit permission relaxation", async () => {
    const staleRoot = makeTempDir();
    const staleTask = task({ issue: 94, state: "queued" });
    staleTask.runtime.phase_override = {
      phase: "implement",
      provider: "codex",
      expires_at_run_id: "previous-run",
    };
    writeTasks(staleRoot, [staleTask]);
    const staleHarness = makeCliHarness(staleRoot, { execFile: () => "ok" });

    assert.equal(await runCli(["doctor"], staleHarness.deps), 1);
    assert.match(staleHarness.stdout(), /FAIL\tphase override\tstale phase_override for #94/);

    const configRoot = makeTempDir();
    writeConfig(
      configRoot,
      `
version: 1
phases:
  plan:
    provider: codex
    permission_profile: write_worktree
`,
    );
    const configHarness = makeCliHarness(configRoot, { execFile: () => "ok" });

    assert.equal(await runCli(["doctor"], configHarness.deps), 1);
    assert.match(configHarness.stdout(), /FAIL\tconfig\tInvalid autokit config/);
  });

  it("renders the effective config phase matrix", async () => {
    const root = makeTempDir();
    writeConfig(
      root,
      `
version: 1
phases:
  plan:
    provider: codex
    effort: high
`,
    );
    const harness = makeCliHarness(root);

    assert.equal(await runCli(["config", "show", "--matrix"], harness.deps), 0);
    assert.match(harness.stdout(), /phase\tprovider\teffort\tprompt_contract\tpermission_profile/);
    assert.match(harness.stdout(), /plan\tcodex\thigh\tplan\treadonly_repo/);
    assert.match(harness.stdout(), /implement\tcodex\tmedium\timplement\twrite_worktree/);
  });

  it("renders issue logs after joining rotated files and applying a second sanitize pass", async () => {
    const root = makeTempDir();
    writeConfig(
      root,
      `
version: 1
logging:
  redact_patterns:
    - custom-secret-[0-9]+
`,
    );
    mkdirSync(join(root, ".autokit", "logs"), { recursive: true });
    const oldLog = join(root, ".autokit", "logs", "2026-05-04.log");
    const newLog = join(root, ".autokit", "logs", "2026-05-05.log");
    const githubToken = dummyGithubToken("3");
    const legacyGithubToken = dummyGithubToken("9");
    const globalOpenAiKey = dummyOpenAiKey("globalsecret");
    const otherOpenAiKey = dummyOpenAiKey("othersecret");
    const structuredRefresh = "structured-refresh-value";
    const structuredOauth = "structured-oauth-value";
    const structuredAccess = "structured-access-value";
    const structuredPrivateKey = "structured-private-key-value";
    const structuredArray = "structured-array-value";
    writeFileSync(
      newLog,
      `${JSON.stringify({
        issue: 96,
        event: "audit",
        message: `new Bearer ${githubToken} custom-secret-42`,
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      oldLog,
      [
        `legacy unscoped ${legacyGithubToken}`,
        JSON.stringify({ message: `global ${globalOpenAiKey}` }),
        JSON.stringify({ issue: 7, message: `other ${otherOpenAiKey}` }),
        JSON.stringify({
          issue: 96,
          event: "audit",
          message: 'old {"refreshToken":"refresh-secret"}',
          details: {
            refreshToken: structuredRefresh,
            oauthAccessToken: structuredOauth,
            access_token: structuredAccess,
            private_key: structuredPrivateKey,
            nested: [{ token: structuredArray }],
          },
        }),
      ].join("\n"),
      { mode: 0o600 },
    );
    utimesSync(oldLog, new Date("2026-05-04T00:00:00Z"), new Date("2026-05-04T00:00:00Z"));
    utimesSync(newLog, new Date("2026-05-05T00:00:00Z"), new Date("2026-05-05T00:00:00Z"));
    const harness = makeCliHarness(root);

    assert.equal(await runCli(["logs", "--issue", "96"], harness.deps), 0);

    const output = harness.stdout();
    assert.match(output, /old/);
    assert.match(output, /new/);
    assert.ok(output.indexOf("old") < output.indexOf("new"));
    assert.match(output, /<REDACTED>/);
    assert.doesNotMatch(output, new RegExp(escapeRegExp(githubToken)));
    assert.doesNotMatch(output, /refresh-secret/);
    assert.doesNotMatch(output, new RegExp(escapeRegExp(structuredRefresh)));
    assert.doesNotMatch(output, new RegExp(escapeRegExp(structuredOauth)));
    assert.doesNotMatch(output, new RegExp(escapeRegExp(structuredAccess)));
    assert.doesNotMatch(output, new RegExp(escapeRegExp(structuredPrivateKey)));
    assert.doesNotMatch(output, new RegExp(escapeRegExp(structuredArray)));
    assert.doesNotMatch(output, new RegExp(escapeRegExp(otherOpenAiKey)));
    assert.doesNotMatch(output, /custom-secret-42/);
    assert.doesNotMatch(output, new RegExp(escapeRegExp(globalOpenAiKey)));
    assert.doesNotMatch(output, new RegExp(escapeRegExp(legacyGithubToken)));
  });

  it("renders git diff through blacklist hunk removal and content sanitize", async () => {
    const root = makeTempDir();
    const calls: string[] = [];
    const openAiKey = dummyOpenAiKey("newsecret");
    const githubToken = dummyGithubToken("4");
    const harness = makeCliHarness(root, {
      execFile: (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        assert.equal(command, "git");
        assert.deepEqual(args, ["diff", "--no-ext-diff", "HEAD", "--"]);
        return [
          "diff --git a/.env b/.env",
          "index 1111111..2222222 100644",
          "--- a/.env",
          "+++ b/.env",
          "@@ -1 +1 @@",
          `-OPENAI_API_KEY=${dummyOpenAiKey("oldsecret")}`,
          `+OPENAI_API_KEY=${openAiKey}`,
          "diff --git a/docs/example.md b/docs/example.md",
          "index 3333333..4444444 100644",
          "--- a/docs/example.md",
          "+++ b/docs/example.md",
          "@@ -1 +1 @@",
          "-safe line",
          `+Bearer ${githubToken}`,
        ].join("\n");
      },
    });

    assert.equal(await runCli(["diff", "--issue", "96"], harness.deps), 0);

    const output = harness.stdout();
    assert.deepEqual(calls, ["git diff --no-ext-diff HEAD --"]);
    assert.match(output, /\[REDACTED hunk: \.env\]/);
    assert.match(output, /docs\/example\.md/);
    assert.match(output, /<REDACTED>/);
    assert.doesNotMatch(output, new RegExp(escapeRegExp(openAiKey)));
    assert.doesNotMatch(output, /OPENAI_API_KEY=/);
    assert.doesNotMatch(output, new RegExp(escapeRegExp(githubToken)));
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

function parseLegacySessionFixture(source: string): {
  phase: AgentPhase;
  expected_last_provider: "claude" | "codex";
  provider_sessions: Partial<Record<AgentPhase, Partial<TaskEntry["provider_sessions"]["plan"]>>>;
} {
  const phase = matchFixtureValue(source, "phase") as AgentPhase;
  const expectedLastProvider = matchFixtureValue(source, "expected_last_provider") as
    | "claude"
    | "codex";
  const providerSession: Partial<TaskEntry["provider_sessions"]["plan"]> = {};
  const claudeSessionId = source.match(/claude_session_id:\s*(\S+)/)?.[1];
  const codexSessionId = source.match(/codex_session_id:\s*(\S+)/)?.[1];
  if (claudeSessionId !== undefined) {
    providerSession.claude_session_id = claudeSessionId;
  }
  if (codexSessionId !== undefined) {
    providerSession.codex_session_id = codexSessionId;
  }
  return {
    phase,
    expected_last_provider: expectedLastProvider,
    provider_sessions: { [phase]: providerSession },
  };
}

type AgentPhase = Exclude<NonNullable<TaskEntry["runtime_phase"]>, "ci_wait" | "merge">;

function matchFixtureValue(source: string, key: string): string {
  const value = source.match(new RegExp(`^${key}:\\s*(\\S+)`, "m"))?.[1];
  if (value === undefined) {
    throw new Error(`missing ${key} in legacy session fixture`);
  }
  return value;
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

function writeConfig(root: string, yaml: string): void {
  mkdirSync(join(root, ".autokit"), { recursive: true });
  writeFileSync(join(root, ".autokit", "config.yaml"), yaml, { mode: 0o600 });
}

function writeAutokitGitignore(root: string): void {
  mkdirSync(join(root, ".autokit"), { recursive: true });
  writeFileSync(join(root, ".autokit", ".gitignore"), "*\n!.gitignore\n!config.yaml\n", {
    mode: 0o600,
  });
}

function createBusyLock(root: string): void {
  const result = tryAcquireRunLock(root, {
    hooks: {
      now: () => new Date("2026-05-07T09:00:00.000Z"),
      randomToken: () => "busy-token",
      hostname: () => "busy-host",
      pid: process.pid,
      getProcessLstart: () => "BUSY",
      isProcessAlive: () => true,
    },
  });
  assert.equal(result.acquired, true);
}

function tasksPath(root: string): string {
  return join(root, ".autokit", "tasks.yaml");
}

function dummyGithubToken(fill: string): string {
  return `ghp_${fill.repeat(36)}`;
}

function dummyOpenAiKey(seed: string): string {
  return `sk-${seed.repeat(3)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autokit-cli-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}
