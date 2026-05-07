import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { type CliDeps, runCli, TEMPFAIL_EXIT_CODE } from "../../packages/cli/src/index.ts";
import {
  type AgentRunInput,
  createTaskEntry,
  manifestDirectory,
  repoBackupId,
  type TaskEntry,
  tryAcquireRunLock,
  writeTasksFileAtomic,
} from "../../packages/core/src/index.ts";
import { type AutokitServeServer, startAutokitServe } from "../../packages/serve/src/index.ts";
import type { WorkflowRunner } from "../../packages/workflows/src/index.ts";

const NOW = "2026-05-07T22:00:00.000Z";

describe("Phase 3 E2E gate", () => {
  it("runs the bundled default apply -> external backup -> doctor -> fake run golden path", async () => {
    const repo = makeTempDir();
    const stateHome = makeTempDir();
    const commands: string[] = [];
    const init = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome }, commands });
    assert.equal(await runCli(["init"], init.deps), 0);
    writeTasks(repo, [task({ issue: 106, state: "queued" })]);

    const tasksBefore = readTasksYaml(repo);
    const agentsBefore = manifestDirectory(join(repo, ".agents"));
    const list = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome }, commands });
    assert.equal(await runCli(["preset", "list"], list.deps), 0);
    assert.match(list.stdout(), /default\tbundled/);

    const show = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome }, commands });
    assert.equal(await runCli(["preset", "show", "default"], show.deps), 0);
    assert.match(show.stdout(), /preset\tdefault\tbundled/);
    assert.match(show.stdout(), /file\tagents\/implementer\.md/);

    const apply = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome }, commands });
    assert.equal(await runCli(["preset", "apply", "default"], apply.deps), 0);
    assert.match(apply.stdout(), /preset applied\tdefault/);
    assert.equal(readTasksYaml(repo), tasksBefore);
    assert.equal(readFileSync(join(repo, ".autokit", ".gitignore"), "utf8"), gitignoreText());
    assert.equal(existsSync(join(repo, ".agents", ".backup")), false);

    const backupAgentsDir = join(backupSnapshotDir(repo, stateHome), ".agents");
    assert.deepEqual(manifestDirectory(backupAgentsDir), agentsBefore);
    assert.notDeepEqual(manifestDirectory(join(repo, ".agents")), agentsBefore);

    const doctor = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome }, commands });
    assert.equal(await runCli(["doctor"], doctor.deps), 0);
    assert.match(doctor.stdout(), /PASS\tprompt contracts\tvalid/);

    const workflowCalls: AgentRunInput[] = [];
    const run = makeProductionRunHarness(repo, stateHome, commands, workflowCalls);
    assert.equal(await runCli(["run"], run.deps), 0);
    assert.match(run.stdout(), /#106\s+merged/);
    assert.deepEqual(
      workflowCalls.map((call) => call.phase),
      ["plan", "plan_verify", "implement", "review"],
    );
    assert.equal(
      commands.some((command) => /^claude\b|^codex\b/.test(command)),
      false,
    );
    assert.ok(commands.includes("gh pr merge 106 --auto --rebase --match-head-commit remote-head"));
  });

  it("applies every initial non-default preset, doctors it, and completes a fake run", async () => {
    for (const preset of ["laravel-filament", "next-shadcn", "docs-create"]) {
      const repo = makeTempDir();
      const stateHome = makeTempDir();
      const commands: string[] = [];
      const init = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome }, commands });
      assert.equal(await runCli(["init"], init.deps), 0, preset);
      writeTasks(repo, [task({ issue: 106, state: "queued" })]);

      const apply = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome }, commands });
      assert.equal(await runCli(["preset", "apply", preset], apply.deps), 0, preset);
      assert.match(
        readFileSync(join(repo, ".agents", "agents", "implementer.md"), "utf8"),
        new RegExp(`preset:${preset}`),
      );

      const doctor = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome }, commands });
      assert.equal(await runCli(["doctor"], doctor.deps), 0, preset);

      const workflowCalls: AgentRunInput[] = [];
      const run = makeProductionRunHarness(repo, stateHome, commands, workflowCalls);
      assert.equal(await runCli(["run"], run.deps), 0, preset);
      assert.deepEqual(
        workflowCalls.map((call) => call.phase),
        ["plan", "plan_verify", "implement", "review"],
        preset,
      );
    }
  });

  it("fails closed with public blacklist/path categories and no literal sensitive paths", async () => {
    const repo = makeTempDir();
    const stateHome = makeTempDir();
    const init = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome } });
    assert.equal(await runCli(["init"], init.deps), 0);
    const agentsBefore = manifestDirectory(join(repo, ".agents"));
    const tasksBefore = readTasksYaml(repo);

    mkdirSync(join(repo, ".autokit", "presets", "bad-credentials", ".codex"), {
      recursive: true,
    });
    writeFileSync(
      join(repo, ".autokit", "presets", "bad-credentials", ".codex", "auth.json"),
      '{"tokens":["secret"]}\n',
      { mode: 0o600 },
    );

    const badShow = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome } });
    assert.equal(await runCli(["preset", "show", "bad-credentials"], badShow.deps), 1);
    assert.match(badShow.stderr(), /preset_blacklist_hit: <blacklist:credentials>/);
    assert.doesNotMatch(badShow.stderr(), /\.codex|auth\.json|secret/);

    const badApply = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome } });
    assert.equal(await runCli(["preset", "apply", "bad-credentials"], badApply.deps), 1);
    assert.match(badApply.stderr(), /preset_blacklist_hit: <blacklist:credentials>/);
    assert.doesNotMatch(badApply.stderr(), /\.codex|auth\.json|secret/);
    assert.deepEqual(manifestDirectory(join(repo, ".agents")), agentsBefore);
    assert.equal(readTasksYaml(repo), tasksBefore);
    assert.ok(readAuditKinds(repo).includes("preset_blacklist_hit"));

    mkdirSync(join(repo, ".autokit", "presets", "symlink"), { recursive: true });
    writeFileSync(join(repo, "outside.md"), "outside\n");
    symlinkSafe(join(repo, "outside.md"), join(repo, ".autokit", "presets", "symlink", "prompts"));
    const traversal = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome } });
    assert.equal(await runCli(["preset", "show", "symlink"], traversal.deps), 1);
    assert.match(traversal.stderr(), /preset_path_traversal: <symlink>/);
    assert.deepEqual(manifestDirectory(join(repo, ".agents")), agentsBefore);
    assert.ok(readAuditKinds(repo).includes("preset_path_traversal"));

    const traversalApply = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome } });
    assert.equal(await runCli(["preset", "apply", "symlink"], traversalApply.deps), 1);
    assert.match(traversalApply.stderr(), /preset_path_traversal: <symlink>/);
    assert.deepEqual(manifestDirectory(join(repo, ".agents")), agentsBefore);
    assert.equal(readTasksYaml(repo), tasksBefore);
    assert.equal(existsSync(backupRoot(repo, stateHome)), false);
  });

  it("fails before backup when existing .agents contains credentials", async () => {
    const repo = makeTempDir();
    const stateHome = makeTempDir();
    const init = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome } });
    assert.equal(await runCli(["init"], init.deps), 0);
    writeTasks(repo, [task({ issue: 106, state: "queued" })]);
    const agentsBefore = manifestDirectory(join(repo, ".agents"));
    const tasksBefore = readTasksYaml(repo);

    writeFileSync(join(repo, ".agents", ".env"), "OPENAI_API_KEY=sk-this-must-not-back-up\n", {
      mode: 0o600,
    });
    const agentsWithSecret = manifestDirectory(join(repo, ".agents"));
    const apply = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome } });
    assert.equal(await runCli(["preset", "apply", "default"], apply.deps), 1);
    assert.match(apply.stderr(), /preset_blacklist_hit: <blacklist:env>/);
    assert.doesNotMatch(apply.stderr(), /OPENAI_API_KEY|sk-this-must-not-back-up/);
    assert.deepEqual(manifestDirectory(join(repo, ".agents")), agentsWithSecret);
    assert.notDeepEqual(agentsWithSecret, agentsBefore);
    assert.equal(readTasksYaml(repo), tasksBefore);
    assert.equal(existsSync(backupRoot(repo, stateHome)), false);
    assert.ok(readAuditKinds(repo).includes("preset_blacklist_hit"));
  });

  it("rolls back after post-rename doctor failure and preserves state during lock contention", async () => {
    const repo = makeTempDir();
    const stateHome = makeTempDir();
    const init = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome } });
    assert.equal(await runCli(["init"], init.deps), 0);
    writeTasks(repo, [task({ issue: 106, state: "queued" })]);
    const agentsBefore = manifestDirectory(join(repo, ".agents"));
    const tasksBefore = readTasksYaml(repo);

    const failingApply = makeCliHarness(repo, {
      env: { XDG_STATE_HOME: stateHome },
      presetPostApplyCheck: ({ repoRoot }) => {
        const nested = tryAcquireRunLock(repoRoot);
        assert.equal(nested.acquired, false);
        throw new Error("injected doctor failure");
      },
    });
    assert.equal(await runCli(["preset", "apply", "default"], failingApply.deps), 1);
    assert.match(failingApply.stderr(), /restored previous \.agents state/);
    assert.match(failingApply.stderr(), /injected doctor failure/);
    assert.deepEqual(manifestDirectory(join(repo, ".agents")), agentsBefore);
    assert.equal(readTasksYaml(repo), tasksBefore);
    assert.deepEqual(
      readAuditKinds(repo).filter((kind) => kind.startsWith("preset_apply")),
      [
        "preset_apply_started",
        "preset_apply_rollback_started",
        "preset_apply_rollback_finished",
        "preset_apply_finished",
      ],
    );

    const apiRun = deferred<{ status: "completed" }>();
    const apiServer = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome,
      env: {},
      now: () => NOW,
      runWorkflow: async () => await apiRun.promise,
    });
    const acceptedRun = await post(apiServer, "/api/run", { issue: 106 });
    assert.equal(acceptedRun.status, 202);
    const busyApplyDuringApiRun = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome } });
    assert.equal(
      await runCli(["preset", "apply", "default"], busyApplyDuringApiRun.deps),
      TEMPFAIL_EXIT_CODE,
    );
    assert.match(busyApplyDuringApiRun.stderr(), /autokit lock busy/);
    assert.deepEqual(manifestDirectory(join(repo, ".agents")), agentsBefore);
    assert.equal(readTasksYaml(repo), tasksBefore);
    apiRun.resolve({ status: "completed" });
    await apiServer.waitForIdle();
    await apiServer.close();

    const held = tryAcquireRunLock(repo);
    assert.equal(held.acquired, true);
    if (!held.acquired) {
      throw new Error("expected held lock");
    }
    const busyApply = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome } });
    assert.equal(await runCli(["preset", "apply", "default"], busyApply.deps), TEMPFAIL_EXIT_CODE);
    assert.match(busyApply.stderr(), /autokit lock busy/);
    assert.deepEqual(manifestDirectory(join(repo, ".agents")), agentsBefore);
    assert.equal(readTasksYaml(repo), tasksBefore);

    const server = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome,
      env: {},
      now: () => NOW,
      runWorkflow: async () => {
        throw new Error("locked request must not dispatch workflow");
      },
    });
    const busyRun = await post(server, "/api/run", { issue: 106 });
    assert.equal(busyRun.status, 409);
    assert.equal(busyRun.body.code, "serve_lock_busy");
    assert.deepEqual(manifestDirectory(join(repo, ".agents")), agentsBefore);
    assert.equal(readTasksYaml(repo), tasksBefore);
    await server.close();
    assert.equal(held.lock.release(), true);
  });

  it("emits rollback-failed evidence when restore cannot recover the previous .agents", async () => {
    const repo = makeTempDir();
    const stateHome = makeTempDir();
    const init = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome } });
    assert.equal(await runCli(["init"], init.deps), 0);
    writeTasks(repo, [task({ issue: 106, state: "queued" })]);
    const agentsBefore = manifestDirectory(join(repo, ".agents"));
    const tasksBefore = readTasksYaml(repo);

    const failingApply = makeCliHarness(repo, {
      env: { XDG_STATE_HOME: stateHome },
      presetPostApplyCheck: ({ repoRoot }) => {
        const previousAgentsDir = readdirSync(repoRoot)
          .filter((entry) => entry.startsWith(".agents.autokit-prev-"))
          .map((entry) => join(repoRoot, entry))[0];
        assert.ok(previousAgentsDir);
        rmSync(previousAgentsDir, { recursive: true, force: true });
        rmSync(join(backupSnapshotDir(repoRoot, stateHome), ".agents"), {
          recursive: true,
          force: true,
        });
        throw new Error("injected restore failure");
      },
    });
    assert.equal(await runCli(["preset", "apply", "default"], failingApply.deps), 1);
    assert.match(failingApply.stderr(), /preset apply rollback failed; inspect backup/);
    assert.match(failingApply.stderr(), /backup/);
    assert.doesNotMatch(failingApply.stderr(), new RegExp(escapeRegExp(repo)));
    assert.equal(readTasksYaml(repo), tasksBefore);
    assert.notDeepEqual(manifestDirectory(join(repo, ".agents")), agentsBefore);
    assert.deepEqual(
      readAuditKinds(repo).filter((kind) => kind.startsWith("preset_apply")),
      ["preset_apply_started", "preset_apply_rollback_started", "preset_apply_rollback_failed"],
    );
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autokit-phase3-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCliHarness(
  cwd: string,
  overrides: Partial<CliDeps> & { commands?: string[] } = {},
): { deps: CliDeps; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  const commands = overrides.commands ?? [];
  return {
    deps: {
      cwd,
      env: {},
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
      execFile: (command, args) => {
        const line = `${command} ${args.join(" ")}`;
        commands.push(line);
        if (line === "git rev-parse --is-inside-work-tree" || line === "gh auth status") {
          return "ok";
        }
        throw new Error(`unexpected external command: ${line}`);
      },
      now: () => NOW,
      ...overrides,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function makeProductionRunHarness(
  repo: string,
  stateHome: string,
  commands: string[],
  workflowCalls: AgentRunInput[],
): { deps: CliDeps; stdout: () => string; stderr: () => string } {
  return makeCliHarness(repo, {
    env: { XDG_STATE_HOME: stateHome },
    commands,
    execFile: workflowExecFile(repo, commands),
    workflowRunner: phase3WorkflowRunner(workflowCalls),
    workflowMaxSteps: 20,
  });
}

function workflowExecFile(repo: string, commands: string[]): CliDeps["execFile"] {
  const expectedWorktree = join(repo, ".autokit", "worktrees", "issue-106");
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

    if (line === "git rev-parse --is-inside-work-tree" || line === "gh auth status") {
      return "ok";
    }
    if (line === "git fetch origin main") {
      return "";
    }
    if (
      command === "git" &&
      args[0] === "worktree" &&
      args[1] === "add" &&
      args[2] === "-b" &&
      args[3] === "autokit/issue-106" &&
      args[4] === expectedWorktree &&
      args[5] === "origin/main"
    ) {
      mkdirSync(expectedWorktree, { recursive: true });
      return "";
    }
    if (line === "gh issue view 106 --json number,title,body,labels,state,url") {
      return JSON.stringify({
        number: 106,
        title: "[v0.2 P3-E2E] Phase 3 E2E gate",
        body: "Phase 3 preset gate fixture",
        labels: [{ name: "agent-ready" }, { name: "type:test" }],
        state: "OPEN",
        url: "https://github.com/cattyneo/agent-autokit/issues/106",
      });
    }
    if (line === "git rev-parse HEAD") {
      const next = revParseResults.shift();
      assert.ok(next, "expected queued rev-parse result");
      return next;
    }
    if (
      line ===
      "gh pr list --head autokit/issue-106 --state all --json number,state,headRefOid,baseRefOid --limit 1"
    ) {
      return "[]";
    }
    if (line === "git add -A") {
      return "";
    }
    if (line === "git commit -m Implement issue #106") {
      return "";
    }
    if (line === "git push -u origin autokit/issue-106") {
      return "";
    }
    if (line.startsWith("gh pr create --draft")) {
      return "https://github.com/cattyneo/agent-autokit/pull/106";
    }
    if (line === "gh pr view 106 --json headRefOid,baseRefOid") {
      return JSON.stringify({ headRefOid: "remote-head", baseRefOid: "base-sha" });
    }
    if (line === "gh pr ready 106") {
      return "";
    }
    if (line === "gh pr view 106 --json statusCheckRollup") {
      return JSON.stringify({
        statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
      });
    }
    if (line === "gh pr view 106 --json headRefOid,mergeable,mergeStateStatus,autoMergeRequest") {
      return JSON.stringify({
        headRefOid: "remote-head",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        autoMergeRequest: null,
      });
    }
    if (line === "gh pr view 106 --json state,mergedAt,headRefOid,mergeable,mergeStateStatus") {
      return JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-05-07T13:00:00Z",
        headRefOid: "remote-head",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      });
    }
    if (line === "gh pr merge 106 --auto --rebase --match-head-commit remote-head") {
      return "";
    }
    if (line === "git push origin --delete autokit/issue-106") {
      return "";
    }
    if (
      command === "git" &&
      args[0] === "worktree" &&
      args[1] === "remove" &&
      args[2] === ".autokit/worktrees/issue-106"
    ) {
      rmSync(expectedWorktree, { recursive: true, force: true });
      return "";
    }
    throw new Error(`unexpected external command: ${line}`);
  };
}

function phase3WorkflowRunner(calls: AgentRunInput[]): WorkflowRunner {
  return async (input) => {
    calls.push(input);
    switch (input.phase) {
      case "plan":
        return completed(input.provider, {
          plan_markdown: "## Phase 3 gate plan",
          assumptions: [],
          risks: [],
        });
      case "plan_verify":
        return completed(input.provider, { result: "ok", findings: [] });
      case "implement":
        return completed(input.provider, {
          changed_files: ["e2e/runners/phase3-gate.test.ts"],
          tests_run: [{ command: "bun test e2e/runners/phase3-gate.test.ts", result: "passed" }],
          docs_updated: false,
          notes: "phase3 gate fixture",
        });
      case "review":
        return completed(input.provider, { findings: [] });
      default:
        throw new Error(`unexpected workflow phase: ${input.phase}`);
    }
  };
}

function completed(provider: "claude" | "codex", structured: Record<string, unknown>) {
  return {
    status: "completed" as const,
    summary: "ok",
    structured,
    session:
      provider === "claude"
        ? { claudeSessionId: "claude-phase3-session" }
        : { codexSessionId: "codex-phase3-session" },
  };
}

function task(input: { issue: number; state: TaskEntry["state"] }): TaskEntry {
  const entry = createTaskEntry({
    issue: input.issue,
    slug: `issue-${input.issue}`,
    title: `Issue ${input.issue}`,
    labels: ["agent-ready"],
    now: NOW,
  });
  entry.state = input.state;
  return entry;
}

function writeTasks(repo: string, tasks: TaskEntry[]): void {
  writeTasksFileAtomic(join(repo, ".autokit", "tasks.yaml"), {
    version: 1,
    generated_at: NOW,
    tasks,
  });
}

function readTasksYaml(repo: string): string {
  return readFileSync(join(repo, ".autokit", "tasks.yaml"), "utf8");
}

function gitignoreText(): string {
  return "*\n!.gitignore\n!config.yaml\n";
}

function timestampForBackup(value: string): string {
  return value.replace(/:/g, ".").replace(/[^0-9A-Za-z.-]/g, "-");
}

function backupRoot(repo: string, stateHome: string): string {
  return join(stateHome, "autokit", "backup", repoBackupId(repo));
}

function backupSnapshotDir(repo: string, stateHome: string): string {
  return join(backupRoot(repo, stateHome), timestampForBackup(NOW));
}

function readAuditKinds(repo: string): string[] {
  const logDir = join(repo, ".autokit", "logs");
  if (!existsSync(logDir)) {
    return [];
  }
  return readdirSync(logDir)
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

function symlinkSafe(target: string, path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
    symlinkSync(target, path);
  } catch (error) {
    throw new Error(
      `failed to create test symlink: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function authHeaders(server: Pick<AutokitServeServer, "token" | "port">): Record<string, string> {
  return {
    authorization: `Bearer ${server.token}`,
    host: `127.0.0.1:${server.port}`,
  };
}

async function post(
  server: Pick<AutokitServeServer, "url" | "token" | "port">,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(server.url(path), {
    method: "POST",
    headers: {
      ...authHeaders(server),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
