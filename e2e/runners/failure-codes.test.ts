import assert from "node:assert/strict";
import {
  existsSync,
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

import { type CliDeps, runCli } from "../../packages/cli/src/index.ts";
import {
  type AgentRunInput,
  createTaskEntry,
  type FailureCode,
  loadTasksFile,
  manifestDirectory,
  type OperationalAuditKind,
  parseConfig,
  repoBackupId,
  type TaskEntry,
  transitionTask,
  tryAcquireRunLock,
  writeTasksFileAtomic,
} from "../../packages/core/src/index.ts";
import {
  type CiWaitDeps,
  computeFindingId,
  type ImplementFixGitDeps,
  type ReviewFinding,
  runCiWaitWorkflow,
  runFixWorkflow,
  runImplementWorkflow,
  runReviewSuperviseWorkflow,
  type WorkflowRunner,
} from "../../packages/workflows/src/index.ts";

const NOW = "2026-05-08T09:00:00.000Z";

type AuditEvent = { kind: OperationalAuditKind | FailureCode; fields: Record<string, unknown> };
type StatefulCode = Extract<
  FailureCode,
  | "review_max"
  | "ci_failure_max"
  | "prompt_contract_violation"
  | "phase_attempt_exceeded"
  | "effort_unsupported"
>;

describe("Issue #113 failure code E2E matrix", () => {
  it("covers stateful failure.code write, resume, retry, and cleanup routes", async () => {
    const cases: Array<{ code: StatefulCode; issue: number; produce: () => Promise<TaskEntry> }> = [
      { code: "review_max", issue: 11301, produce: produceReviewMax },
      { code: "ci_failure_max", issue: 11302, produce: produceCiFailureMax },
      {
        code: "prompt_contract_violation",
        issue: 11303,
        produce: producePromptContractViolation,
      },
      { code: "phase_attempt_exceeded", issue: 11304, produce: producePhaseAttemptExceeded },
      { code: "effort_unsupported", issue: 11305, produce: produceEffortUnsupported },
    ];

    for (const entry of cases) {
      const failed = attachRetryResidue(await entry.produce(), entry.issue);
      assert.equal(failed.state, "failed", entry.code);
      assert.equal(failed.failure?.code, entry.code, entry.code);

      const repo = makeTempDir();
      writeTasks(repo, [failed]);
      const loaded = loadTasksFile(tasksPath(repo)).tasks[0];
      assert.equal(loaded?.failure?.code, entry.code, entry.code);

      const beforeResume = readTasksYaml(repo);
      const resume = makeCliHarness(repo);
      assert.equal(await runCli(["resume", String(entry.issue)], resume.deps), 1, entry.code);
      assert.match(resume.stderr(), /is not paused/, entry.code);
      assert.equal(readTasksYaml(repo), beforeResume, entry.code);

      const retryCommands: string[] = [];
      const retry = makeCliHarness(repo, { commands: retryCommands });
      assert.equal(await runCli(["retry", String(entry.issue)], retry.deps), 0, entry.code);
      const retried = loadTasksFile(tasksPath(repo)).tasks[0];
      assert.equal(retried?.state, "queued", entry.code);
      assert.equal(retried?.failure, null, entry.code);
      assert.equal(retried?.pr.number, null, entry.code);
      assert.equal(retried?.branch, null, entry.code);
      assert.equal(retried?.worktree_path, null, entry.code);
      assert.deepEqual(
        retryCommands,
        [
          `gh pr close ${entry.issue + 1_000} --delete-branch --comment autokit retry: superseded`,
          `git worktree remove --force .autokit/worktrees/issue-${entry.issue}`,
          `git branch -D codex/issue-${entry.issue}`,
        ],
        entry.code,
      );

      writeTasks(repo, [failed]);
      const beforeCleanup = readTasksYaml(repo);
      const cleanup = makeCliHarness(repo);
      assert.equal(
        await runCli(["cleanup", "--force-detach", String(entry.issue)], cleanup.deps),
        1,
        entry.code,
      );
      assert.match(cleanup.stderr(), /not a force-detach candidate/, entry.code);
      assert.equal(readTasksYaml(repo), beforeCleanup, entry.code);
    }
  });

  it("covers non-stateful preset and lock failures without task mutation", async () => {
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
    const blacklist = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome } });
    assert.equal(await runCli(["preset", "apply", "bad-credentials"], blacklist.deps), 1);
    assert.match(blacklist.stderr(), /preset_blacklist_hit: <blacklist:credentials>/);
    assert.deepEqual(manifestDirectory(join(repo, ".agents")), agentsBefore);
    assert.equal(readTasksYaml(repo), tasksBefore);

    mkdirSync(join(repo, ".autokit", "presets", "symlink"), { recursive: true });
    writeFileSync(join(repo, "outside.md"), "outside\n");
    symlinkSync(join(repo, "outside.md"), join(repo, ".autokit", "presets", "symlink", "prompts"));
    const traversal = makeCliHarness(repo, { env: { XDG_STATE_HOME: stateHome } });
    assert.equal(await runCli(["preset", "apply", "symlink"], traversal.deps), 1);
    assert.match(traversal.stderr(), /preset_path_traversal: <symlink>/);
    assert.deepEqual(manifestDirectory(join(repo, ".agents")), agentsBefore);
    assert.equal(readTasksYaml(repo), tasksBefore);
    assert.equal(existsSync(backupRoot(repo, stateHome)), false);

    writeTasks(repo, [task({ issue: 11306, state: "queued" })]);
    const tasksBeforeLock = readTasksYaml(repo);
    const foreignLock = tryAcquireRunLock(repo, {
      hooks: {
        now: () => new Date(NOW),
        randomToken: () => "foreign-token",
        hostname: () => "foreign-host.example",
        pid: 99_999_999,
        getProcessLstart: () => "FOREIGN-LSTART",
      },
    });
    assert.equal(foreignLock.acquired, true);

    const mismatch = makeCliHarness(repo, {
      runWorkflow: () => {
        throw new Error("lock_host_mismatch must reject before workflow dispatch");
      },
    });
    assert.equal(await runCli(["run"], mismatch.deps), 1);
    assert.match(mismatch.stderr(), /lock_host_mismatch/);
    assert.equal(readTasksYaml(repo), tasksBeforeLock);

    const forced = makeCliHarness(repo, {
      confirm: () => true,
      runWorkflow: () => loadTasksFile(tasksPath(repo)).tasks,
    });
    assert.equal(await runCli(["--force-unlock", "run"], forced.deps), 75);
    assert.match(forced.stderr(), /lock_seized/);
    assert.equal(existsSync(join(repo, ".autokit", ".lock")), false);

    const auditEvents = readAuditEvents(repo);
    const auditKinds = auditEvents.map((event) => event.kind);
    assert.ok(auditKinds.includes("preset_blacklist_hit"));
    assert.ok(auditKinds.includes("preset_path_traversal"));
    assert.ok(auditKinds.includes("lock_host_mismatch"));
    assert.ok(auditKinds.includes("lock_seized"));
    const lockSeized = auditEvents.find((event) => event.kind === "lock_seized");
    assert.ok(lockSeized);
    assert.equal(asRecord(lockSeized.prior).pid, 99_999_999);
    assert.equal(asRecord(lockSeized.prior).host, "foreign-host");
    assert.equal(asRecord(lockSeized.prior).started_at_lstart, "FOREIGN-LSTART");
    assert.equal(asRecord(lockSeized.seizing).pid, process.pid);
    assert.equal(typeof asRecord(lockSeized.seizing).host, "string");
    assert.equal(typeof asRecord(lockSeized.seizing).started_at_lstart, "string");
    assert.equal(asRecord(lockSeized.seizing).command, "autokit --force-unlock");
    assert.equal(JSON.stringify(auditEvents).includes("holder_token"), false);
  });
});

async function produceReviewMax(): Promise<TaskEntry> {
  const audits: AuditEvent[] = [];
  let task = reviewingTask(11301);
  const config = parseConfig({ review: { max_rounds: 2 } });
  for (const _round of [1, 2]) {
    const review = await runAcceptedReview(task, audits, config);
    task = (await runFix(review.task, audits)).task;
  }
  const result = await runAcceptedReview(task, audits, config);
  assertFailureAudit(audits, "review_max");
  return result.task;
}

async function produceCiFailureMax(): Promise<TaskEntry> {
  const audits: AuditEvent[] = [];
  let task = ciWaitingTask(11302);
  const gh = fakeGh({
    checkRollups: [
      [failedCheck("test-1", "101")],
      [failedCheck("test-2", "102")],
      [failedCheck("test-3", "103")],
    ],
    runLogs: { "101": "first", "102": "second", "103": "third" },
  });
  for (const _round of [1, 2]) {
    const ci = await runCiWaitWorkflow(task, {
      runner: queueRunner([], []),
      github: ciDepsFromGh(gh),
      repoRoot: "/repo",
      worktreeRoot: "/repo/.autokit/worktrees/issue-11302",
      config: parseConfig({ ci: { fix_max_rounds: 2 } }),
      auditFailure: (input) => recordFailure(audits, input),
    });
    task = (await runReviewPass((await runFix(ci.task, [])).task)).task;
  }
  const result = await runCiWaitWorkflow(task, {
    runner: queueRunner([], []),
    github: ciDepsFromGh(gh),
    repoRoot: "/repo",
    worktreeRoot: "/repo/.autokit/worktrees/issue-11302",
    config: parseConfig({ ci: { fix_max_rounds: 2 } }),
    auditFailure: (input) => recordFailure(audits, input),
  });
  assertFailureAudit(audits, "ci_failure_max");
  return result.task;
}

async function producePromptContractViolation(): Promise<TaskEntry> {
  const audits: AuditEvent[] = [];
  const calls: AgentRunInput[] = [];
  const result = await runReviewSuperviseWorkflow(reviewingTask(11303), {
    runner: async (input) => {
      calls.push(input);
      throw Object.assign(new Error("bad review payload"), {
        code: "prompt_contract_violation",
      });
    },
    repoRoot: "/repo",
    worktreeRoot: "/repo/.autokit/worktrees/issue-11303",
    auditFailure: (input) => recordFailure(audits, input),
  });
  assert.equal(calls.length, 2);
  assertFailureAudit(audits, "prompt_contract_violation");
  return result.task;
}

async function producePhaseAttemptExceeded(): Promise<TaskEntry> {
  const audits: AuditEvent[] = [];
  const calls: AgentRunInput[] = [];
  const task = fixingTask(11304, "review");
  task.runtime.phase_attempt = 2;
  task.git.checkpoints.fix.before_sha = "fix-before";
  task.git.checkpoints.fix.rebase_done = "rebased";
  const result = await runFixWorkflow(task, {
    runner: queueRunner(calls, []),
    git: mockGitDeps([], []),
    repoRoot: "/repo",
    worktreeRoot: "/repo/.autokit/worktrees/issue-11304",
    auditFailure: (input) => recordFailure(audits, input),
  });
  assert.equal(calls.length, 0);
  assertFailureAudit(audits, "phase_attempt_exceeded");
  return result.task;
}

async function produceEffortUnsupported(): Promise<TaskEntry> {
  const result = await runImplementWorkflow(implementReadyTask(11305), {
    runner: queueRunner([], []),
    git: mockGitDeps(["base-sha"], []),
    repoRoot: "/repo",
    worktreeRoot: "/repo/.autokit/worktrees/issue-11305",
    homeDir: "/Users/tester",
    config: parseConfig({
      effort: { unsupported_policy: "fail" },
      phases: { implement: { provider: "codex", effort: "high", model: "gpt-5.4-mini" } },
    }),
    now: () => NOW,
  });
  return result.task;
}

async function runAcceptedReview(
  task: TaskEntry,
  audits: AuditEvent[],
  config: ReturnType<typeof parseConfig>,
) {
  const finding = reviewFinding();
  const findingId = computeFindingId(finding);
  return runReviewSuperviseWorkflow(task, {
    runner: queueRunner(
      [],
      [
        completed("claude", { findings: [finding] }),
        completed("claude", {
          accept_ids: [findingId],
          reject_ids: [],
          reject_reasons: {},
          fix_prompt: "Fix the finding.",
        }),
      ],
    ),
    repoRoot: "/repo",
    worktreeRoot: `/repo/.autokit/worktrees/issue-${task.issue}`,
    config,
    auditOperation: (kind, fields) => audits.push({ kind, fields }),
    auditFailure: (input) => recordFailure(audits, input),
  });
}

async function runFix(task: TaskEntry, audits: AuditEvent[]) {
  return runFixWorkflow(task, {
    runner: queueRunner(
      [],
      [
        completed("codex", {
          changed_files: ["packages/core/src/index.ts"],
          tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
          resolved_accept_ids: task.review_findings.at(-1)?.accept_ids ?? [],
          unresolved_accept_ids: [],
          notes: "fixed",
        }),
      ],
    ),
    git: mockGitDeps(["fix-before", "rebased", "agent-done"], ["fix-commit"], {
      prHeadSha: "fix-remote-head",
      baseSha: "base-sha",
    }),
    repoRoot: "/repo",
    worktreeRoot: `/repo/.autokit/worktrees/issue-${task.issue}`,
    auditOperation: (kind, fields) => audits.push({ kind, fields }),
  });
}

async function runReviewPass(task: TaskEntry) {
  return runReviewSuperviseWorkflow(task, {
    runner: queueRunner([], [completed("claude", { findings: [] })]),
    repoRoot: "/repo",
    worktreeRoot: `/repo/.autokit/worktrees/issue-${task.issue}`,
  });
}

function attachRetryResidue(task: TaskEntry, issue: number): TaskEntry {
  return {
    ...task,
    issue,
    pr: {
      number: issue + 1_000,
      head_sha: `head-${issue}`,
      base_sha: "base-sha",
      created_at: NOW,
    },
    branch: `codex/issue-${issue}`,
    worktree_path: `.autokit/worktrees/issue-${issue}`,
  };
}

function reviewingTask(issue: number): TaskEntry {
  const task = createTaskEntry({
    issue,
    slug: `issue-${issue}`,
    title: `Issue ${issue}`,
    labels: ["agent-ready"],
    now: NOW,
  });
  return {
    ...transitionTask(
      {
        ...task,
        state: "implementing",
        runtime_phase: "implement",
        branch: `codex/issue-${issue}`,
        worktree_path: `.autokit/worktrees/issue-${issue}`,
      },
      { type: "pr_ready", headSha: `head-${issue}`, prNumber: issue + 1_000, baseSha: "base-sha" },
    ),
    branch: `codex/issue-${issue}`,
    worktree_path: `.autokit/worktrees/issue-${issue}`,
  };
}

function fixingTask(issue: number, origin: "review" | "ci"): TaskEntry {
  return {
    ...reviewingTask(issue),
    state: "fixing",
    runtime_phase: "fix",
    fix: { origin, started_at: NOW, ci_failure_log: null },
  };
}

function ciWaitingTask(issue: number): TaskEntry {
  return {
    ...reviewingTask(issue),
    state: "ci_waiting",
    runtime_phase: "ci_wait",
    pr: {
      number: issue + 1_000,
      head_sha: `head-${issue}`,
      base_sha: "base-sha",
      created_at: NOW,
    },
    review_findings: [{ round: 1, accept_ids: [], reject_ids: [], reject_reasons: {} }],
  };
}

function implementReadyTask(issue: number): TaskEntry {
  const task = createTaskEntry({
    issue,
    slug: `issue-${issue}`,
    title: `Issue ${issue}`,
    labels: ["agent-ready"],
    now: NOW,
  });
  return {
    ...task,
    state: "planned",
    branch: `codex/issue-${issue}`,
    worktree_path: `.autokit/worktrees/issue-${issue}`,
    plan: { ...task.plan, state: "verified" },
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

function reviewFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "P1",
    file: "packages/workflows/src/index.ts",
    line: 382,
    title: "Loop evidence missing",
    rationale: "The review-fix loop must emit observable audit evidence.",
    suggested_fix: "Emit an audit event at the loop boundary.",
    ...overrides,
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

function queueRunner(
  calls: AgentRunInput[],
  outputs: Awaited<ReturnType<WorkflowRunner>>[],
): WorkflowRunner {
  return async (input) => {
    calls.push(input);
    const output = outputs.shift();
    assert.ok(output, `unexpected runner call for ${input.phase}`);
    return output;
  };
}

function mockGitDeps(
  headShas: string[],
  commitShas: string[],
  options: { prHeadSha?: string; baseSha?: string | null } = {},
): ImplementFixGitDeps {
  return {
    getHeadSha: () => {
      const sha = headShas.shift();
      assert.ok(sha, "expected a queued head sha");
      return sha;
    },
    stageAll: () => undefined,
    commit: () => {
      const sha = commitShas.shift();
      assert.ok(sha, "expected a queued commit sha");
      return sha;
    },
    pushBranch: () => undefined,
    createDraftPr: () => 95,
    getPrHead: () => ({
      headSha: options.prHeadSha ?? "remote-head",
      baseSha: options.baseSha ?? null,
    }),
    markPrReady: () => undefined,
    rebaseOntoBase: () => ({ ok: true }),
  };
}

function fakeGh(options: {
  checkRollups: Array<Array<Record<string, unknown>>>;
  runLogs: Record<string, string>;
}) {
  return (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view" && args[4] === "statusCheckRollup") {
      const next = options.checkRollups.shift();
      assert.ok(next, "expected queued statusCheckRollup");
      return { ok: true, stdout: { statusCheckRollup: next }, status: 0 };
    }
    if (args[0] === "run" && args[1] === "view" && args[3] === "--log-failed") {
      const log = options.runLogs[String(args[2])];
      assert.ok(log, `expected queued failed log for run ${args[2]}`);
      return { ok: true, stdout: log, status: 0 };
    }
    throw new Error(`unexpected gh args: ${JSON.stringify(args)}`);
  };
}

function ciDepsFromGh(gh: ReturnType<typeof fakeGh>): CiWaitDeps {
  return {
    getChecks: (prNumber) => {
      const checks = gh(["pr", "view", String(prNumber), "--json", "statusCheckRollup"]);
      const rollup = asRecord(checks.stdout).statusCheckRollup;
      assert.ok(Array.isArray(rollup));
      const failed = rollup.filter((check) => String(asRecord(check).conclusion) !== "SUCCESS");
      return failed.length === 0
        ? { status: "success" }
        : {
            status: "failure",
            failedLog: failed.map((check) => failedCheckLog(gh, asRecord(check))).join("\n\n"),
          };
    },
    getPr: () => ({ headSha: "head-sha", mergeable: "MERGEABLE", autoMergeRequest: null }),
    reserveAutoMerge: () => undefined,
    disableAutoMerge: () => undefined,
    sleep: () => undefined,
  };
}

function failedCheck(name: string, runId: string): Record<string, unknown> {
  return {
    name,
    status: "COMPLETED",
    conclusion: "FAILURE",
    detailsUrl: `https://github.com/cattyneo/agent-autokit/actions/runs/${runId}/job/1`,
  };
}

function failedCheckLog(gh: ReturnType<typeof fakeGh>, check: Record<string, unknown>): string {
  const name = String(check.name ?? "unknown check");
  const runId = String(check.detailsUrl ?? "").match(/\/actions\/runs\/([0-9]+)/)?.[1];
  assert.ok(runId, "expected run id");
  const result = gh(["run", "view", runId, "--log-failed"]);
  return [`check: ${name}`, String(result.stdout ?? "")].join("\n");
}

function recordFailure(
  audits: AuditEvent[],
  input: { failure: { code: FailureCode }; payload?: Record<string, unknown> },
): void {
  audits.push({
    kind: input.failure.code,
    fields: { failure: input.failure, payload: input.payload },
  });
}

function assertFailureAudit(audits: AuditEvent[], code: FailureCode): void {
  const event = audits.find((entry) => entry.kind === code);
  assert.ok(event, `expected failure audit kind: ${code}`);
  const failure = event.fields.failure as { code?: unknown; phase?: unknown; message?: unknown };
  assert.equal(failure.code, code);
  assert.equal(typeof failure.phase, "string");
  assert.equal(typeof failure.message, "string");
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
        commands.push(`${command} ${args.join(" ")}`);
        return "";
      },
      now: () => NOW,
      ...overrides,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function writeTasks(repo: string, tasks: TaskEntry[]): void {
  writeTasksFileAtomic(tasksPath(repo), {
    version: 1,
    generated_at: NOW,
    tasks,
  });
}

function tasksPath(repo: string): string {
  return join(repo, ".autokit", "tasks.yaml");
}

function readTasksYaml(repo: string): string {
  return readFileSync(tasksPath(repo), "utf8");
}

function readAuditEvents(repo: string): Array<Record<string, unknown> & { kind: string }> {
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
        .map((line) => JSON.parse(line) as Record<string, unknown> & { kind?: string }),
    )
    .filter(
      (entry): entry is Record<string, unknown> & { kind: string } =>
        typeof entry.kind === "string",
    );
}

function backupRoot(repo: string, stateHome: string): string {
  return join(stateHome, "autokit", "backup", repoBackupId(repo));
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autokit-failure-codes-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}
