import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { type CliDeps, runCli, TEMPFAIL_EXIT_CODE } from "../../packages/cli/src/index.ts";
import {
  createTaskEntry,
  loadTasksFile,
  type RunLockHooks,
  type TaskEntry,
  tryAcquireRunLock,
  waitAcquireRunLock,
  writeTasksFileAtomic,
} from "../../packages/core/src/index.ts";
import {
  type AutokitServeServer,
  type ServeWorkflowInput,
  startAutokitServe,
} from "../../packages/serve/src/index.ts";

const NOW = "2026-05-07T21:00:00.000Z";
const FAKE_OPENAI_KEY = `sk-${"2".repeat(22)}`;
const FAKE_ANTHROPIC_KEY = "anthropic-phase2a-secret";
const FAKE_CODEX_KEY = "codex-phase2a-secret";

describe("Phase 2A E2E gate", () => {
  it("runs the lock -> 409 -> SSE replay -> redact golden path without live providers", async () => {
    const repo = makeRepo(
      [task({ issue: 102, state: "queued" })],
      [
        "version: 1",
        "logging:",
        "  level: debug",
        "  redact_patterns:",
        "    - prompt-phase2a-secret",
        "serve:",
        "  sse:",
        "    heartbeat_ms: 10",
      ].join("\n"),
    );
    const stateHome = makeTempDir();
    const finish = deferred<{ status: "completed" }>();
    const workflowCalls: ServeWorkflowInput[] = [];
    const audits: Array<{ kind: string; fields: Record<string, unknown> }> = [];
    const server = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome,
      env: { ...process.env, HOME: "/Users/tester" },
      now: () => NOW,
      runId: () => "run-phase2a",
      auditOperation: (kind, fields) => audits.push({ kind, fields }),
      runWorkflow: async (input) => {
        workflowCalls.push(input);
        input.emitEvent?.({
          kind: "phase_started",
          data: { issue: 102, phase: "implement", provider: "codex", effort: "medium", at: NOW },
        });
        input.emitEvent?.({
          kind: "runner_stdout",
          data: {
            issue: 102,
            phase: "implement",
            chunk: [
              `Bearer ${server.token}`,
              '{"api_key":"credential-phase2a-secret"}',
              '{"prompt_contract":{"data":{"answer":"prompt-phase2a-secret"}}}',
              '{"status":"completed","data":{"summary":"prompt-phase2a-secret"}}',
            ].join(" "),
            at: NOW,
          },
        });
        return await finish.promise;
      },
    });
    assert.equal(server.host, "127.0.0.1");
    const stream = await openSse(server, "/api/events");

    assert.equal(await rawStatus(server, "/api/run", { method: "POST", body: "{}" }), 401);

    const accepted = await post(server, "/api/run", {
      issue: 102,
      idempotency_key: "phase2a-same-run",
    });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.run_id, "run-phase2a");
    const sameRun = await post(server, "/api/run", {
      issue: 102,
      idempotency_key: "phase2a-same-run",
    });
    assert.equal(sameRun.status, 202);
    assert.equal(sameRun.body.run_id, "run-phase2a");
    assert.equal(workflowCalls.length, 1);

    const runnerFrame = await waitForSseFrame(
      stream.response,
      (frame) => frame.event === "runner_stdout",
    );
    const runnerPayload = JSON.stringify(runnerFrame.data);
    assert.doesNotMatch(runnerPayload, new RegExp(escapeRegExp(server.token)));
    assert.doesNotMatch(runnerPayload, /credential-phase2a-secret|prompt-phase2a-secret/);
    assert.match(runnerPayload, /<REDACTED>/);

    const beforeCli = readTasksYaml(repo);
    const cli = makeCliHarness(repo);
    assert.equal(await runCli(["run"], cli.deps), TEMPFAIL_EXIT_CODE);
    assert.match(cli.stderr(), /autokit lock busy/);
    assert.equal(readTasksYaml(repo), beforeCli);
    const afterCliTasks = loadTasksFile(join(repo, ".autokit", "tasks.yaml")).tasks;
    assert.equal(afterCliTasks[0]?.failure, null);

    const busy = await post(server, "/api/run", { issue: 102 });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, "serve_lock_busy");
    assert.equal(readTasksYaml(repo), beforeCli);
    assert.equal(audits.at(-1)?.kind, "serve_lock_busy");

    const liveAuditFrame = await waitForSseFrame(
      stream.response,
      (frame) => frame.event === "audit" && frame.data.kind === "serve_lock_busy",
    );
    assert.ok(runnerFrame.id);
    assert.ok(liveAuditFrame.id);
    stream.response.destroy();

    const replay = await openSse(server, "/api/events", {
      "last-event-id": runnerFrame.id,
    });
    const replayedAudit = await waitForSseFrame(
      replay.response,
      (frame) => frame.id === liveAuditFrame.id,
    );
    assert.equal(replayedAudit.event, "audit");
    assert.equal(replayedAudit.data.kind, "serve_lock_busy");
    const heartbeat = await waitForSseFrame(
      replay.response,
      (frame) => frame.event === "heartbeat",
    );
    assert.deepEqual(heartbeat.data, {});
    replay.response.destroy();

    finish.resolve({ status: "completed" });
    await server.waitForIdle();
    await server.close();
  });

  it("observes CLI-held lock 409, auth matrix, read redaction, and API-key fail-closed", async () => {
    const entry = task({ issue: 102, state: "queued" });
    entry.plan.path = "docs/plans/impl-102.md";
    entry.worktree_path = ".agents/worktrees/issue-102";
    const repo = makeRepo([entry]);
    mkdirSync(join(repo, "docs", "plans"), { recursive: true });
    mkdirSync(join(repo, entry.worktree_path), { recursive: true });
    mkdirSync(join(repo, ".autokit", "logs"), { recursive: true });
    writeFileSync(join(repo, entry.plan.path), "# Phase 2A plan\n");
    writeFileSync(
      join(repo, ".autokit", "logs", "2026-05-07.log"),
      `${JSON.stringify({
        issue: 102,
        level: "info",
        message: FAKE_OPENAI_KEY,
        padding: "x".repeat(200),
      })}\n`,
      { mode: 0o600 },
    );
    const server = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome: makeTempDir(),
      now: () => NOW,
      readDiff: () =>
        [
          "diff --git a/.env b/.env",
          "--- a/.env",
          "+++ b/.env",
          `+OPENAI_API_KEY=${FAKE_OPENAI_KEY}`,
          "diff --git a/docs/example.md b/docs/example.md",
          "--- a/docs/example.md",
          "+++ b/docs/example.md",
          `+token ${FAKE_OPENAI_KEY}`,
        ].join("\n"),
      runWorkflow: async () => ({ status: "completed" }),
    });

    assert.equal(await status(server, "/api/tasks"), 401);
    assert.equal(await status(server, `/api/tasks?token=${server.token}`), 401);
    assert.equal(await status(server, "/api/tasks", { cookie: `token=${server.token}` }), 401);
    for (const host of [
      `127.0.0.1:${server.port}`,
      `LOCALHOST:${server.port}`,
      `localhost.:${server.port}`,
      `[::1]:${server.port}`,
    ]) {
      assert.equal(await status(server, "/api/tasks", authHeaders(server, { host })), 200, host);
    }
    assert.equal(
      await status(server, "/api/tasks", authHeaders(server, { host: "evil.example" })),
      403,
    );
    assert.equal(await status(server, "/api/tasks", authHeaders(server)), 200);
    assert.equal(await status(server, "/api/tasks", authHeaders(server, { origin: "null" })), 403);
    assert.equal(
      await status(server, "/api/tasks", authHeaders(server, { origin: "https://evil.example" })),
      403,
    );
    assert.equal(
      await rawStatus(server, "/api/run", {
        method: "POST",
        headers: authHeaders(server, { contentType: "text/plain" }),
        body: "{}",
      }),
      415,
    );

    const before = readTasksYaml(repo);
    const lock = tryAcquireRunLock(repo, { hooks: lockHooks("cli-holder") });
    assert.equal(lock.acquired, true);
    if (!lock.acquired) {
      throw new Error("expected CLI-held lock");
    }
    const busy = await post(server, "/api/run", { issue: 102 });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, "serve_lock_busy");
    assert.equal(readTasksYaml(repo), before);
    assert.equal(lock.lock.release(), true);

    const logs = await json(server, "/api/tasks/102/logs?max_bytes=80");
    assert.equal(logs.status, 200);
    assert.equal(logs.body.truncated, true);
    assert.equal(typeof logs.body.next_cursor, "string");
    assert.doesNotMatch(JSON.stringify(logs.body), /sk-222/);

    const diff = await json(server, "/api/tasks/102/diff?max_bytes=2000");
    assert.equal(diff.status, 200);
    const diffBody = JSON.stringify(diff.body);
    assert.doesNotMatch(diffBody, /OPENAI_API_KEY|sk-222/);
    assert.match(diffBody, /\[REDACTED hunk: credential path\]|<REDACTED>/);
    await server.close();

    const apiKeyRepo = makeRepo(
      [task({ issue: 102, state: "queued" })],
      "version: 1\nlogging:\n  level: debug\n",
    );
    const preflightServer = await startAutokitServe({
      repoRoot: apiKeyRepo,
      port: 0,
      stateHome: makeTempDir(),
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
        CODEX_API_KEY: FAKE_CODEX_KEY,
        OPENAI_API_KEY: FAKE_OPENAI_KEY,
      },
      now: () => NOW,
      runWorkflow: async () => {
        throw new Error("provider-backed workflow must not dispatch");
      },
    });
    const apiKeyStream = await openSse(preflightServer, "/api/events");
    preflightServer.publishEvent({
      kind: "runner_stdout",
      data: {
        issue: 102,
        phase: "implement",
        chunk: [FAKE_OPENAI_KEY, FAKE_ANTHROPIC_KEY, FAKE_CODEX_KEY].join(" "),
        at: NOW,
      },
    });
    const apiKeyFrame = await waitForSseFrame(
      apiKeyStream.response,
      (frame) => frame.event === "runner_stdout",
    );
    assert.doesNotMatch(
      JSON.stringify(apiKeyFrame.data),
      /sk-222|anthropic-phase2a-secret|codex-phase2a-secret/,
    );
    apiKeyStream.response.destroy();
    const rejected = await post(preflightServer, "/api/run", { issue: 102 });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, "provider_api_key_env");
    await preflightServer.close();
  });

  it("covers process-lock split-brain prevention, init/doctor hygiene, token isolation, and resume_required recovery", async () => {
    const raceRoot = makeTempDir();
    const first = tryAcquireRunLock(raceRoot, { hooks: lockHooks("race-a") });
    assert.equal(first.acquired, true);
    if (!first.acquired) {
      throw new Error("expected initial lock");
    }
    let released = false;
    let lateAcquire: ReturnType<typeof tryAcquireRunLock> | null = null;
    const waited = await waitAcquireRunLock(raceRoot, {
      timeout_ms: 2,
      poll_interval_ms: 1,
      hooks: {
        ...lockHooks("race-b"),
        sleep: async () => {
          if (!released) {
            released = true;
            assert.equal(first.lock.release(), true);
            lateAcquire = tryAcquireRunLock(raceRoot, { hooks: lockHooks("race-c") });
          }
        },
      },
    });
    assert.equal(waited.acquired, false);
    assert.equal(lateAcquire?.acquired, true);
    assert.equal([waited, lateAcquire].filter((result) => result?.acquired === true).length, 1);
    assert.equal(statSync(join(raceRoot, ".autokit", ".lock")).mode & 0o777, 0o700);
    assert.equal(statSync(join(raceRoot, ".autokit", ".lock", "holder.json")).mode & 0o777, 0o600);
    const holder = JSON.parse(
      readFileSync(join(raceRoot, ".autokit", ".lock", "holder.json"), "utf8"),
    ) as { host: string };
    assert.equal(holder.host, "phase2a-host");

    const initRoot = makeTempDir();
    const init = makeCliHarness(initRoot, { execFile: () => "ok" });
    assert.equal(await runCli(["init"], init.deps), 0);
    assert.equal(readFileSync(join(initRoot, ".autokit", ".gitignore"), "utf8"), gitignoreText());
    rmSync(join(initRoot, ".autokit", ".gitignore"));
    const doctor = makeCliHarness(initRoot, { execFile: () => "ok" });
    assert.equal(await runCli(["doctor"], doctor.deps), 1);
    assert.match(doctor.stdout(), /FAIL\t.autokit gitignore\t.autokit\/.gitignore missing/);

    const stateHome = makeTempDir();
    const firstServer = await startAutokitServe({
      repoRoot: makeRepo(),
      port: 0,
      stateHome,
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    const secondServer = await startAutokitServe({
      repoRoot: makeRepo(),
      port: 0,
      stateHome,
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    assert.notEqual(firstServer.token, secondServer.token);
    assert.notEqual(firstServer.tokenPath, secondServer.tokenPath);
    assert.equal(existsSync(firstServer.tokenPath), true);
    assert.equal(existsSync(secondServer.tokenPath), true);
    await firstServer.close();
    assert.equal(existsSync(firstServer.tokenPath), false);
    assert.equal(existsSync(secondServer.tokenPath), true);
    await secondServer.close();

    const repo = makeRepo([task({ issue: 102, state: "implementing" })]);
    const restartStateHome = makeTempDir();
    const crashed = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome: restartStateHome,
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    const recordDir = join(restartStateHome, "autokit", "runs", crashed.repoId);
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, "run-crashed.json"),
      `${JSON.stringify({
        run_id: "run-crashed",
        repo_id: crashed.repoId,
        operation: "run",
        issue: 102,
        status: "running",
        accepted_at: NOW,
        updated_at: NOW,
      })}\n`,
      { mode: 0o600 },
    );
    await crashed.close();
    const restarted = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome: restartStateHome,
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    const response = await post(restarted, "/api/run", { issue: 102 });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "resume_required");
    assert.equal(response.body.run_id, "run-crashed");
    await restarted.close();
  });
});

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

function makeRepo(tasks: TaskEntry[] = [], config = "version: 1\n"): string {
  const root = makeTempDir();
  mkdirSync(join(root, ".autokit"), { recursive: true });
  writeFileSync(join(root, ".autokit", ".gitignore"), gitignoreText(), { mode: 0o600 });
  writeFileSync(join(root, ".autokit", "config.yaml"), `${config.trimEnd()}\n`, { mode: 0o600 });
  writeTasksFileAtomic(join(root, ".autokit", "tasks.yaml"), {
    version: 1,
    generated_at: NOW,
    tasks,
  });
  return root;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autokit-phase2a-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function gitignoreText(): string {
  return "*\n!.gitignore\n!config.yaml\n";
}

function readTasksYaml(repo: string): string {
  return readFileSync(join(repo, ".autokit", "tasks.yaml"), "utf8");
}

function makeCliHarness(
  cwd: string,
  overrides: Partial<CliDeps> = {},
): { deps: CliDeps; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    deps: {
      cwd,
      env: {},
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
      execFile: () => {
        throw new Error("unexpected execFile call");
      },
      workflowRunner: async () => {
        throw new Error("unexpected workflow dispatch");
      },
      now: () => NOW,
      ...overrides,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function lockHooks(token: string): RunLockHooks {
  return {
    now: () => new Date(NOW),
    randomToken: () => token,
    hostname: () => "phase2a-host.internal.example",
    pid: process.pid,
    getProcessLstart: () => token,
    isProcessAlive: () => true,
    sleep: async () => undefined,
  };
}

function authHeaders(
  server: Pick<AutokitServeServer, "token" | "port">,
  overrides: { host?: string; origin?: string; contentType?: string } = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${server.token}`,
    host: overrides.host ?? `127.0.0.1:${server.port}`,
    ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
    ...(overrides.contentType === undefined ? {} : { "content-type": overrides.contentType }),
  };
}

async function status(
  server: Pick<AutokitServeServer, "url" | "token" | "port">,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const response = await fetch(server.url(path), { headers });
  await response.body?.cancel();
  return response.status;
}

async function rawStatus(
  server: Pick<AutokitServeServer, "url" | "token" | "port">,
  path: string,
  init: RequestInit,
): Promise<number> {
  const response = await fetch(server.url(path), init);
  await response.body?.cancel();
  return response.status;
}

async function json(
  server: Pick<AutokitServeServer, "url" | "token" | "port">,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(server.url(path), { headers: authHeaders(server) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
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

async function openSse(
  server: Pick<AutokitServeServer, "url" | "token" | "port">,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  request: ReturnType<typeof httpRequest>;
  response: IncomingMessage;
}> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      server.url(path),
      { headers: { ...authHeaders(server), ...headers } },
      (response) => {
        resolve({ request, response });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

type SseFrame = {
  id?: string;
  event?: string;
  data: Record<string, unknown>;
};

const sseReaders = new WeakMap<IncomingMessage, SseReader>();

async function waitForSseFrame(
  response: IncomingMessage,
  predicate: (frame: SseFrame) => boolean,
): Promise<SseFrame> {
  let reader = sseReaders.get(response);
  if (reader === undefined) {
    reader = new SseReader(response);
    sseReaders.set(response, reader);
  }
  return await reader.waitFor(predicate);
}

class SseReader {
  private buffer = "";
  private readonly frames: SseFrame[] = [];
  private readonly waiters: Array<{
    predicate: (frame: SseFrame) => boolean;
    resolve: (frame: SseFrame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(response: IncomingMessage) {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => this.onData(chunk));
    response.on("error", (error: Error) => this.rejectAll(error));
    response.on("close", () =>
      this.rejectAll(new Error(`SSE stream closed before matching frame; buffer=${this.buffer}`)),
    );
  }

  async waitFor(predicate: (frame: SseFrame) => boolean): Promise<SseFrame> {
    const existing = this.takeFrame(predicate);
    if (existing !== undefined) {
      return existing;
    }
    return await new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(new Error(`timed out waiting for SSE frame; buffer=${this.buffer}`));
        }, 2000),
      };
      this.waiters.push(waiter);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split(/\n\n/);
    this.buffer = parts.pop() ?? "";
    for (const part of parts) {
      const frame = parseSseFrame(part);
      if (frame !== null) {
        this.frames.push(frame);
      }
    }
    this.drain();
  }

  private drain(): void {
    for (const waiter of [...this.waiters]) {
      const frame = this.takeFrame(waiter.predicate);
      if (frame !== undefined) {
        this.removeWaiter(waiter);
        waiter.resolve(frame);
      }
    }
  }

  private takeFrame(predicate: (frame: SseFrame) => boolean): SseFrame | undefined {
    const index = this.frames.findIndex(predicate);
    if (index === -1) {
      return undefined;
    }
    const [frame] = this.frames.splice(index, 1);
    return frame;
  }

  private removeWaiter(waiter: (typeof this.waiters)[number]): void {
    clearTimeout(waiter.timer);
    const index = this.waiters.indexOf(waiter);
    if (index !== -1) {
      this.waiters.splice(index, 1);
    }
  }

  private rejectAll(error: Error): void {
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.reject(error);
    }
  }
}

function parseSseFrame(raw: string): SseFrame | null {
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0 && !line.startsWith(":"));
  if (lines.length === 0) {
    return null;
  }
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("id:")) {
      id = line.slice("id:".length).trimStart();
    } else if (line.startsWith("event:")) {
      event = line.slice("event:".length).trimStart();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  return { id, event, data: JSON.parse(data.join("")) as Record<string, unknown> };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
