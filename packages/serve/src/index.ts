import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  type AutokitConfig,
  assertProductionApiKeyEnvUnset,
  buildGhEnv,
  capabilityPhases,
  capabilityProviders,
  createAutokitLogger,
  DEFAULT_CONFIG,
  type EffortLevel,
  effortLevels,
  loadTasksFile,
  type OperationalAuditKind,
  type Phase,
  type Provider,
  parseConfigYaml,
  redactGitDiff,
  sanitizeLogString,
  type TaskEntry,
  type TasksFile,
  tryAcquireRunLock,
} from "@cattyneo/autokit-core";

export type ServeOperation = "run" | "resume" | "retry" | "cleanup";
export type ServeRunStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "interrupted"
  | "resume_required";

export type ServeWorkflowInput = {
  repoRoot: string;
  operation: ServeOperation;
  issue?: number;
  phase?: Phase;
  provider?: Provider;
  effort?: EffortLevel;
  merged_only?: boolean;
  run_id: string;
  emitEvent?: (event: ServeSseEventInput) => string | null;
  auditOperation?: (kind: OperationalAuditKind, fields: Record<string, unknown>) => void;
};

export type ServeWorkflowResult = {
  status?: Exclude<ServeRunStatus, "accepted" | "running" | "resume_required">;
  cleaned?: number;
};

export type AutokitServeOptions = {
  repoRoot: string;
  port?: number;
  host?: string;
  stateHome?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  runId?: () => string;
  runWorkflow: (input: ServeWorkflowInput) => Promise<ServeWorkflowResult> | ServeWorkflowResult;
  readDiff?: (input: { cwd: string; issue: number }) => string;
  auditOperation?: (kind: OperationalAuditKind, fields: Record<string, unknown>) => void;
  hooks?: {
    writeSseFrame?: (response: ServerResponse, frame: string) => boolean;
  };
};

export type AutokitServeServer = {
  host: string;
  port: number;
  repoId: string;
  token: string;
  tokenPath: string;
  url: (path: string) => string;
  publishEvent: (event: ServeSseEventInput) => string | null;
  waitForIdle: () => Promise<void>;
  close: () => Promise<void>;
};

export const serveSseEventKinds = [
  "task_state",
  "phase_started",
  "phase_finished",
  "audit",
  "runner_stdout",
  "heartbeat",
  "error",
] as const;

export type ServeSseEventKind = (typeof serveSseEventKinds)[number];

export type ServeSseEventInput =
  | {
      kind: "task_state";
      data: { issue: number; state: string; runtime_phase: string | null; updated_at: string };
    }
  | {
      kind: "phase_started" | "phase_finished";
      data: {
        issue: number;
        phase: string;
        provider?: string;
        effort?: string;
        at: string;
      };
    }
  | {
      kind: "audit";
      data: {
        kind: string;
        issue?: number;
        message?: string;
        details?: Record<string, unknown>;
        at: string;
      };
    }
  | {
      kind: "runner_stdout";
      data: { issue: number; phase: string; chunk: string; at: string; truncated?: boolean };
    }
  | { kind: "heartbeat"; data: Record<string, never> }
  | { kind: "error"; data: { code: string; message: string } };

type RunRecord = {
  run_id: string;
  repo_id: string;
  operation: ServeOperation;
  issue?: number;
  idempotency_key?: string;
  status: ServeRunStatus;
  accepted_at: string;
  updated_at: string;
  cleaned?: number;
  failure?: { code: string; message: string };
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const LOG_DIFF_DEFAULT_MAX_BYTES = 16_384;
const LOG_DIFF_HARD_MAX_BYTES = 65_536;
const BODY_MAX_BYTES = 65_536;
const DIFF_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SSE_REPLAY_CAPACITY = 64;
const SSE_FRAME_MAX_BYTES = 65_536;
const SSE_TRUNCATED_CHUNK_MAX_BYTES = 60_000;
const mutatingPaths = new Set(["/api/run", "/api/resume", "/api/retry", "/api/cleanup"]);
const allowedBindHosts = new Set(["127.0.0.1", "localhost"]);

export async function startAutokitServe(options: AutokitServeOptions): Promise<AutokitServeServer> {
  const repoRoot = realpathSync(options.repoRoot);
  const env = options.env ?? process.env;
  const host = options.host ?? DEFAULT_HOST;
  assertAllowedBindHost(host);
  const config = loadConfig(repoRoot);
  const repoId = repoIdFor(repoRoot);
  markInterruptedRunsResumeRequired(env, options.stateHome, repoId, options);
  const pending = new Set<Promise<void>>();
  const token = randomBytes(32).toString("base64url");
  const logger = createAutokitLogger({
    logDir: join(repoRoot, ".autokit", "logs"),
    config,
    now: options.now === undefined ? undefined : () => new Date(options.now?.() ?? ""),
  });
  const auditOperation =
    options.auditOperation ?? ((kind, fields) => logger.auditOperation(kind, fields));
  const sseHub = new SseHub({
    config,
    env,
    repoRoot,
    now: () => now(options),
    getToken: () => token,
    auditOperation,
    writeFrame: options.hooks?.writeSseFrame,
  });
  let actualPort = 0;
  let tokenPath = "";

  const server = createServer((request, response) => {
    void handleRequest({
      request,
      response,
      options,
      repoRoot,
      env,
      config,
      repoId,
      getPort: () => actualPort,
      getToken: () => token,
      auditOperation: (kind, fields) => {
        auditOperation(kind, fields);
        publishAuditSseEvents(sseHub, kind, fields, now(options));
      },
      pending,
      sseHub,
    });
  });

  try {
    await listen(server, options.port ?? DEFAULT_PORT, host);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("autokit serve did not bind to a TCP port");
    }
    actualPort = address.port;
    tokenPath = writeServeToken(stateHome(env, options.stateHome), repoId, actualPort, token);
  } catch (error) {
    sseHub.close();
    await closeServer(server).catch(() => {});
    if (tokenPath !== "") {
      unlinkIfExists(tokenPath);
    }
    logger.close();
    throw error;
  }

  return {
    host,
    port: actualPort,
    repoId,
    token,
    tokenPath,
    url: (path) => `http://${host}:${actualPort}${path}`,
    publishEvent: (event) => sseHub.publish(event),
    waitForIdle: async () => {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
    close: async () => {
      sseHub.close();
      await closeServer(server);
      unlinkIfExists(tokenPath);
      logger.close();
    },
  };
}

type RequestContext = {
  request: IncomingMessage;
  response: ServerResponse;
  options: AutokitServeOptions;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  config: AutokitConfig;
  repoId: string;
  getPort: () => number;
  getToken: () => string;
  auditOperation: (kind: OperationalAuditKind, fields: Record<string, unknown>) => void;
  pending: Set<Promise<void>>;
  sseHub: SseHub;
};

async function handleRequest(context: RequestContext): Promise<void> {
  const auth = authorize(context.request, context.getToken(), context.getPort());
  if (!auth.ok) {
    sendError(context.response, auth.status, auth.code, auth.message);
    return;
  }

  const url = new URL(context.request.url ?? "/", `http://127.0.0.1:${context.getPort()}`);
  const path = url.pathname;

  try {
    if (context.request.method === "GET" && path === "/api/tasks") {
      sendJson(context.response, 200, {
        ok: true,
        tasks: loadTasksOrEmpty(context.repoRoot).tasks,
      });
      return;
    }
    if (context.request.method === "GET" && /^\/api\/tasks\/\d+$/.test(path)) {
      const issue = issueFromPath(path, 3);
      const task = findTask(context.repoRoot, issue);
      if (task === undefined) {
        sendError(context.response, 404, "not_found", "task not found");
        return;
      }
      sendJson(context.response, 200, { ok: true, task });
      return;
    }
    if (context.request.method === "GET" && /^\/api\/tasks\/\d+\/plan$/.test(path)) {
      handlePlan(context, issueFromPath(path, 3));
      return;
    }
    if (context.request.method === "GET" && /^\/api\/tasks\/\d+\/reviews$/.test(path)) {
      handleReviews(context, issueFromPath(path, 3));
      return;
    }
    if (context.request.method === "GET" && /^\/api\/tasks\/\d+\/logs$/.test(path)) {
      handleLogs(context, issueFromPath(path, 3), url.searchParams);
      return;
    }
    if (context.request.method === "GET" && /^\/api\/tasks\/\d+\/diff$/.test(path)) {
      handleDiff(context, issueFromPath(path, 3), url.searchParams);
      return;
    }
    if (context.request.method === "GET" && path === "/api/events") {
      handleEvents(context.request, context.response, context.sseHub);
      return;
    }
    if (context.request.method === "POST" && mutatingPaths.has(path)) {
      await handleMutation(context, path);
      return;
    }
    sendError(context.response, 404, "not_found", "route not found");
  } catch (error) {
    sendError(
      context.response,
      500,
      "internal_error",
      sanitizeLogString(error instanceof Error ? error.message : String(error), context.config),
    );
  }
}

function authorize(
  request: IncomingMessage,
  expectedToken: string,
  port: number,
):
  | { ok: true }
  | { ok: false; status: 401 | 403; code: "unauthorized" | "forbidden"; message: string } {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return { ok: false, status: 401, code: "unauthorized", message: "bearer token required" };
  }
  const suppliedToken = authorization.slice("Bearer ".length);
  if (!safeTokenEqual(suppliedToken, expectedToken)) {
    return { ok: false, status: 401, code: "unauthorized", message: "bearer token required" };
  }
  if (!isAllowedHostHeader(request.headers.host, port)) {
    return { ok: false, status: 403, code: "forbidden", message: "host not allowed" };
  }
  const origin = request.headers.origin;
  if (!isAllowedOriginHeader(origin, port)) {
    return { ok: false, status: 403, code: "forbidden", message: "origin not allowed" };
  }
  return { ok: true };
}

async function handleMutation(context: RequestContext, path: string): Promise<void> {
  const operation = path.slice("/api/".length) as ServeOperation;
  if (!isJsonContentType(context.request.headers["content-type"])) {
    sendError(
      context.response,
      415,
      "unsupported_media_type",
      "content-type must be application/json",
    );
    return;
  }
  let body: Record<string, unknown>;
  try {
    assertProductionApiKeyEnvUnset(context.env);
    body = await readJsonBody(context.request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendError(context.response, 413, "payload_too_large", "request body too large");
      return;
    }
    sendError(
      context.response,
      400,
      error instanceof Error && error.name === "ProductionApiKeyEnvError"
        ? "provider_api_key_env"
        : "bad_request",
      error instanceof Error ? error.message : "invalid request",
    );
    return;
  }

  const parsed = validateMutationBody(operation, body);
  if (!parsed.ok) {
    sendError(context.response, 400, "bad_request", parsed.message);
    return;
  }

  const existing = findRunByIdempotency(
    runsDir(context.env, context.options.stateHome, context.repoId),
    operation,
    parsed.idempotency_key,
  );
  if (existing !== undefined) {
    sendJson(context.response, operation === "cleanup" ? 200 : 202, {
      ok: true,
      accepted: operation !== "cleanup",
      cleaned: existing.cleaned,
      run_id: existing.run_id,
      status: existing.status,
    });
    return;
  }

  const resumeRequired = findResumeRequiredRun(
    runsDir(context.env, context.options.stateHome, context.repoId),
    operation,
    parsed.issue,
  );
  if (resumeRequired !== undefined) {
    sendJson(context.response, 409, {
      ok: false,
      code: "resume_required",
      message: "previous run requires resume",
      request_id: randomUUID(),
      run_id: resumeRequired.run_id,
      status: resumeRequired.status,
    });
    return;
  }

  if (hasActiveTaskConflict(context.repoRoot, parsed.issue)) {
    sendError(context.response, 409, "active_task", "task is already active");
    return;
  }

  const runId = context.options.runId?.() ?? `run-${randomUUID()}`;
  const lock = tryAcquireRunLock(context.repoRoot, { config: context.config, runId });
  if (!lock.acquired) {
    context.auditOperation("serve_lock_busy", {
      operation,
      issue: parsed.issue ?? null,
      holder: lock.holder,
    });
    sendError(context.response, 409, "serve_lock_busy", "autokit serve lock busy");
    return;
  }

  const record: RunRecord = {
    run_id: runId,
    repo_id: context.repoId,
    operation,
    issue: parsed.issue,
    idempotency_key: parsed.idempotency_key,
    status: "accepted",
    accepted_at: now(context.options),
    updated_at: now(context.options),
  };
  const recordPath = writeRunRecord(context.env, context.options.stateHome, record);

  const workflowInput: ServeWorkflowInput = {
    repoRoot: context.repoRoot,
    operation,
    issue: parsed.issue,
    phase: parsed.phase,
    provider: parsed.provider,
    effort: parsed.effort,
    merged_only: parsed.merged_only,
    run_id: runId,
    emitEvent: (event) => context.sseHub.publish(event),
    auditOperation: context.auditOperation,
  };

  if (operation === "cleanup") {
    try {
      const result = await context.options.runWorkflow(workflowInput);
      record.status = result.status ?? "completed";
      record.cleaned = result.cleaned ?? 0;
      record.updated_at = now(context.options);
      atomicWriteJson(recordPath, record, 0o600);
      publishTaskState(context, parsed.issue);
      if (!lock.lock.release()) {
        markLockReleaseFailed(record, recordPath, context.options);
        sendError(context.response, 500, "lock_release_failed", "run lock release failed");
        return;
      }
      sendJson(context.response, 200, { ok: true, cleaned: record.cleaned, run_id: runId });
    } catch (error) {
      record.status = "failed";
      record.updated_at = now(context.options);
      atomicWriteJson(recordPath, record, 0o600);
      sendError(
        context.response,
        500,
        "workflow_failed",
        sanitizeLogString(error instanceof Error ? error.message : String(error), context.config),
      );
      lock.lock.release();
    }
    return;
  }

  const background = runCoordinator(context, workflowInput, record, recordPath, lock.lock.release);
  context.pending.add(background);
  background.finally(() => context.pending.delete(background)).catch(() => {});
  sendJson(context.response, 202, {
    ok: true,
    accepted: true,
    run_id: runId,
    status: record.status,
  });
}

async function runCoordinator(
  context: RequestContext,
  input: ServeWorkflowInput,
  record: RunRecord,
  recordPath: string,
  release: () => boolean,
): Promise<void> {
  try {
    record.status = "running";
    record.updated_at = now(context.options);
    atomicWriteJson(recordPath, record, 0o600);
    publishTaskState(context, input.issue);
    const result = await context.options.runWorkflow(input);
    record.status = result.status ?? "completed";
    record.cleaned = result.cleaned;
    record.updated_at = now(context.options);
    atomicWriteJson(recordPath, record, 0o600);
    publishTaskState(context, input.issue);
  } catch {
    record.status = "failed";
    record.updated_at = now(context.options);
    atomicWriteJson(recordPath, record, 0o600);
    publishTaskState(context, input.issue);
  } finally {
    if (!release()) {
      markLockReleaseFailed(record, recordPath, context.options);
    }
  }
}

function markLockReleaseFailed(
  record: RunRecord,
  recordPath: string,
  options: AutokitServeOptions,
): void {
  record.status = "failed";
  record.failure = {
    code: "lock_release_failed",
    message: "run lock release failed",
  };
  record.updated_at = now(options);
  atomicWriteJson(recordPath, record, 0o600);
}

function handlePlan(context: RequestContext, issue: number): void {
  const task = findTask(context.repoRoot, issue);
  if (task === undefined || !existsSync(join(context.repoRoot, task.plan.path))) {
    sendError(context.response, 404, "not_found", "plan not found");
    return;
  }
  sendJson(context.response, 200, {
    ok: true,
    issue,
    markdown: readFileSync(join(context.repoRoot, task.plan.path), "utf8"),
  });
}

function handleReviews(context: RequestContext, issue: number): void {
  const task = findTask(context.repoRoot, issue);
  if (task === undefined) {
    sendError(context.response, 404, "not_found", "task not found");
    return;
  }
  sendJson(context.response, 200, { ok: true, issue, reviews: task.review_findings });
}

function handleLogs(context: RequestContext, issue: number, params: URLSearchParams): void {
  if (findTask(context.repoRoot, issue) === undefined) {
    sendError(context.response, 404, "not_found", "task not found");
    return;
  }
  const bounds = parseBounds(params, true);
  if (!bounds.ok) {
    sendError(context.response, bounds.status, bounds.code, bounds.message);
    return;
  }
  const lines = readLogLines(context.repoRoot, issue, context.config, context.env);
  const selected =
    bounds.tailLines === undefined
      ? lines
      : lines.slice(Math.max(0, lines.length - bounds.tailLines));
  const bounded = boundText(selected.join("\n"), bounds.maxBytes, bounds.cursor);
  sendJson(context.response, 200, { ok: true, issue, logs: bounded.value, ...bounded.meta });
}

function handleDiff(context: RequestContext, issue: number, params: URLSearchParams): void {
  const task = findTask(context.repoRoot, issue);
  if (task === undefined) {
    sendError(context.response, 404, "not_found", "task not found");
    return;
  }
  const bounds = parseBounds(params, false);
  if (!bounds.ok) {
    sendError(context.response, bounds.status, bounds.code, bounds.message);
    return;
  }
  const diffRoot =
    task.worktree_path === null ? context.repoRoot : resolve(context.repoRoot, task.worktree_path);
  const diffCwd = existsSync(diffRoot) ? diffRoot : context.repoRoot;
  const rawDiff =
    context.options.readDiff?.({ cwd: diffCwd, issue }) ??
    execFileSync("git", ["diff", "--no-ext-diff", "HEAD", "--"], {
      cwd: diffCwd,
      encoding: "utf8",
      env: buildGhEnv(context.env),
      maxBuffer: DIFF_MAX_BUFFER_BYTES,
    });
  const redacted = redactGitDiff(rawDiff, context.config, {
    homeDir: context.env.HOME,
    repoRoot: diffCwd,
  });
  const bounded = boundText(redacted, bounds.maxBytes, bounds.cursor);
  sendJson(context.response, 200, { ok: true, issue, diff: bounded.value, ...bounded.meta });
}

function handleEvents(request: IncomingMessage, response: ServerResponse, sseHub: SseHub): void {
  sseHub.connect(response, headerValue(request.headers["last-event-id"]));
}

type SseBufferedFrame = {
  id: string;
  kind: ServeSseEventKind;
  text: string;
};

type SseClient = {
  response: ServerResponse;
  closed: boolean;
};

type SseHubOptions = {
  config: AutokitConfig;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  getToken: () => string;
  now: () => string;
  auditOperation?: (kind: OperationalAuditKind, fields: Record<string, unknown>) => void;
  writeFrame?: (response: ServerResponse, frame: string) => boolean;
};

class SseHub {
  private readonly clients = new Set<SseClient>();
  private readonly buffer: SseBufferedFrame[] = [];
  private readonly options: SseHubOptions;
  private nextId = 1;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SseHubOptions) {
    this.options = options;
  }

  publish(event: ServeSseEventInput): string | null {
    if (event.kind === "runner_stdout" && this.options.config.logging.level !== "debug") {
      return null;
    }
    const frame = this.createFrame(event);
    this.buffer.push(frame);
    if (this.buffer.length > SSE_REPLAY_CAPACITY) {
      this.buffer.shift();
    }
    for (const client of [...this.clients]) {
      this.writeFrame(client, frame);
    }
    return frame.id;
  }

  connect(response: ServerResponse, lastEventId: string | undefined): void {
    if (this.clients.size >= this.options.config.serve.sse.max_connections) {
      sendError(response, 503, "sse_connection_limit", "too many event streams");
      return;
    }
    const client: SseClient = { response, closed: false };
    this.clients.add(client);
    response.on("close", () => this.removeClient(client));
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.flushHeaders();
    this.replay(client, lastEventId);
    this.ensureHeartbeat();
  }

  close(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of [...this.clients]) {
      this.closeClient(client);
    }
  }

  private replay(client: SseClient, lastEventId: string | undefined): void {
    if (lastEventId === undefined || lastEventId.length === 0) {
      return;
    }
    const index = this.buffer.findIndex((frame) => frame.id === lastEventId);
    if (index === -1) {
      this.writeFrame(
        client,
        this.createFrame({
          kind: "error",
          data: { code: "replay_unavailable", message: "SSE replay unavailable; reload required" },
        }),
      );
      return;
    }
    for (const frame of this.buffer.slice(index + 1)) {
      if (client.closed) {
        return;
      }
      this.writeFrame(client, frame);
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.clients.size === 0) {
        if (this.heartbeatTimer !== null) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        return;
      }
      this.publish({ kind: "heartbeat", data: {} });
    }, this.options.config.serve.sse.heartbeat_ms);
    this.heartbeatTimer.unref?.();
  }

  private createFrame(event: ServeSseEventInput): SseBufferedFrame {
    const id = String(this.nextId);
    this.nextId += 1;
    const redactedData = sanitizeSseValue(event.data, this.options) as Record<string, unknown>;
    const capped = capSsePayload(event.kind, redactedData);
    const text = formatSseFrame(id, capped.kind, capped.data);
    if (Buffer.byteLength(text, "utf8") <= SSE_FRAME_MAX_BYTES) {
      return {
        id,
        kind: capped.kind,
        text,
      };
    }
    return {
      id,
      kind: "error",
      text: formatSseFrame(id, "error", {
        code: "event_too_large",
        message: "SSE event payload too large; payload omitted",
      }),
    };
  }

  private writeFrame(client: SseClient, frame: SseBufferedFrame): void {
    if (client.closed) {
      return;
    }
    let ok = false;
    try {
      ok =
        this.options.writeFrame?.(client.response, frame.text) ?? client.response.write(frame.text);
    } catch {
      this.options.auditOperation?.("sse_write_failed", {
        reason: "write_exception",
        event: frame.kind,
      });
      this.closeClient(client);
      return;
    }
    if (!ok) {
      this.writeBackpressureAndClose(client, frame.kind);
    }
  }

  private writeBackpressureAndClose(client: SseClient, failedEvent: ServeSseEventKind): void {
    if (client.closed) {
      return;
    }
    this.options.auditOperation?.("sse_write_failed", {
      reason: "backpressure",
      event: failedEvent,
    });
    const frame = this.createFrame({
      kind: "error",
      data: { code: "backpressure", message: "SSE backpressure; reconnect required" },
    });
    try {
      this.options.writeFrame?.(client.response, frame.text) ?? client.response.write(frame.text);
    } catch {
      // The client is already unhealthy; close it without surfacing to workflow callers.
    }
    this.closeClient(client);
  }

  private closeClient(client: SseClient): void {
    if (client.closed) {
      return;
    }
    client.closed = true;
    this.clients.delete(client);
    try {
      client.response.end();
    } catch {
      client.response.destroy();
    }
    if (this.clients.size === 0 && this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private removeClient(client: SseClient): void {
    client.closed = true;
    this.clients.delete(client);
    if (this.clients.size === 0 && this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

function publishAuditSseEvents(
  sseHub: SseHub,
  kind: OperationalAuditKind,
  fields: Record<string, unknown>,
  at: string,
): void {
  const issue = optionalNumberField(fields.issue);
  const phase = optionalStringField(fields.phase ?? fields.runtime_phase);
  if (kind === "phase_started" && issue !== undefined && phase !== undefined) {
    sseHub.publish({
      kind: "phase_started",
      data: {
        issue,
        phase,
        ...optionalSseStringFields(fields),
        at,
      },
    });
    return;
  }
  if (kind === "phase_completed" && issue !== undefined && phase !== undefined) {
    sseHub.publish({
      kind: "phase_finished",
      data: {
        issue,
        phase,
        ...optionalSseStringFields(fields),
        at,
      },
    });
    return;
  }
  sseHub.publish({
    kind: "audit",
    data: {
      kind,
      ...(issue === undefined ? {} : { issue }),
      message: String(kind),
      details: fields,
      at,
    },
  });
}

function publishTaskState(context: RequestContext, issue: number | undefined): void {
  if (issue === undefined) {
    return;
  }
  const task = findTask(context.repoRoot, issue);
  if (task === undefined) {
    return;
  }
  context.sseHub.publish({
    kind: "task_state",
    data: {
      issue: task.issue,
      state: task.state,
      runtime_phase: task.runtime_phase,
      updated_at: now(context.options),
    },
  });
}

function sanitizeSseValue(
  value: unknown,
  options: SseHubOptions,
  key?: string,
  parentKey?: string,
): unknown {
  if (key === "data" || (parentKey === "prompt_contract" && key === "data")) {
    return "<REDACTED>";
  }
  if (typeof value === "string") {
    const jsonRedacted = redactJsonLikeSensitiveValues(value);
    const redacted =
      key === "diff" || jsonRedacted.includes("diff --git ")
        ? redactGitDiff(jsonRedacted, options.config, redactionPaths(options))
        : jsonRedacted;
    return redactLiteralSecrets(
      sanitizeLogString(redacted, options.config, false, redactionPaths(options)),
      options,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSseValue(entry, options, key, parentKey));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => {
        if (isSensitiveKey(entryKey)) {
          return [entryKey, "<REDACTED>"];
        }
        return [entryKey, sanitizeSseValue(entryValue, options, entryKey, key)];
      }),
    );
  }
  return value;
}

function formatSseFrame(
  id: string,
  kind: ServeSseEventKind,
  data: Record<string, unknown>,
): string {
  return `id: ${id}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
}

function capSsePayload(
  kind: ServeSseEventKind,
  data: Record<string, unknown>,
): { kind: ServeSseEventKind; data: Record<string, unknown> } {
  const text = formatSseFrame("0", kind, data);
  if (Buffer.byteLength(text, "utf8") <= SSE_FRAME_MAX_BYTES) {
    return { kind, data };
  }
  if (kind === "runner_stdout" && typeof data.chunk === "string") {
    return {
      kind,
      data: {
        ...data,
        chunk: truncateUtf8(data.chunk, SSE_TRUNCATED_CHUNK_MAX_BYTES),
        truncated: true,
      },
    };
  }
  if (kind === "audit") {
    return {
      kind,
      data: {
        ...data,
        message:
          typeof data.message === "string"
            ? truncateUtf8(data.message, 8_192)
            : "audit payload truncated",
        details: { truncated: true },
      },
    };
  }
  return { kind, data };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }
  return `${buffer
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "")}...[truncated]`;
}

function redactJsonLikeSensitiveValues(value: string): string {
  const keyPattern =
    /"(?:api[_-]?key|apiKey|client[_-]?secret|clientSecret|credentials?|secret|password|private[_-]?key|privateKey|data)"\s*:/gi;
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(keyPattern)) {
    const matchIndex = match.index ?? 0;
    result += value.slice(cursor, matchIndex);
    result += match[0];
    const valueStart = skipWhitespace(value, matchIndex + match[0].length);
    result += value.slice(matchIndex + match[0].length, valueStart);
    const valueEnd = findJsonLikeValueEnd(value, valueStart);
    result += '"<REDACTED>"';
    cursor = valueEnd;
  }
  result += value.slice(cursor);
  return result;
}

function skipWhitespace(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length && /\s/.test(value[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function findJsonLikeValueEnd(value: string, start: number): number {
  const first = value[start];
  if (first === '"') {
    return findJsonStringEnd(value, start);
  }
  if (first === "{" || first === "[") {
    return findBalancedJsonEnd(value, start, first === "{" ? "}" : "]");
  }
  let cursor = start;
  while (cursor < value.length && !/[\s,}\]]/.test(value[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function findJsonStringEnd(value: string, start: number): number {
  let escaped = false;
  for (let cursor = start + 1; cursor < value.length; cursor += 1) {
    const char = value[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return cursor + 1;
    }
  }
  return value.length;
}

function findBalancedJsonEnd(value: string, start: number, close: "}" | "]"): number {
  const open = value[start];
  const stack = [close];
  let inString = false;
  let escaped = false;
  for (let cursor = start + 1; cursor < value.length; cursor += 1) {
    const char = value[cursor];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push("}");
      continue;
    }
    if (char === "[") {
      stack.push("]");
      continue;
    }
    if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) {
        return cursor + 1;
      }
    }
  }
  return open === "{" || open === "[" ? value.length : start;
}

function redactLiteralSecrets(value: string, options: SseHubOptions): string {
  return [
    options.getToken(),
    options.env.ANTHROPIC_API_KEY,
    options.env.OPENAI_API_KEY,
    options.env.CODEX_API_KEY,
  ]
    .filter((secret): secret is string => secret !== undefined && secret.length > 0)
    .reduce(
      (redacted, secret) => redacted.replace(new RegExp(escapeRegExp(secret), "g"), "<REDACTED>"),
      value,
    );
}

function redactionPaths(options: SseHubOptions): { homeDir?: string; repoRoot?: string } {
  return { homeDir: options.env.HOME, repoRoot: options.repoRoot };
}

function optionalNumberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalSseStringFields(fields: Record<string, unknown>): {
  provider?: string;
  effort?: string;
} {
  return {
    ...(optionalStringField(fields.provider) === undefined
      ? {}
      : { provider: optionalStringField(fields.provider) }),
    ...(optionalStringField(fields.effort) === undefined
      ? {}
      : { effort: optionalStringField(fields.effort) }),
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function validateMutationBody(
  operation: ServeOperation,
  body: Record<string, unknown>,
):
  | {
      ok: true;
      issue?: number;
      phase?: Phase;
      provider?: Provider;
      effort?: EffortLevel;
      idempotency_key?: string;
      merged_only?: boolean;
    }
  | { ok: false; message: string } {
  const allowed = {
    run: ["issue", "phase", "provider", "effort", "idempotency_key"],
    resume: ["issue", "idempotency_key"],
    retry: ["issue", "idempotency_key"],
    cleanup: ["issue", "merged_only"],
  } satisfies Record<ServeOperation, string[]>;
  const extras = Object.keys(body).filter((key) => !allowed[operation].includes(key));
  if (extras.length > 0) {
    return { ok: false, message: `unknown keys: ${extras.join(",")}` };
  }
  const issue = optionalPositiveInteger(body.issue);
  if (issue === "invalid" || (operation === "retry" && issue === undefined)) {
    return { ok: false, message: "issue must be a positive integer" };
  }
  const phase = optionalEnum(body.phase, capabilityPhases);
  if (phase === "invalid") {
    return { ok: false, message: "unsupported phase" };
  }
  const provider = optionalEnum(body.provider, capabilityProviders);
  if (provider === "invalid") {
    return { ok: false, message: "unsupported provider" };
  }
  const effort = optionalEnum(body.effort, effortLevels);
  if (effort === "invalid") {
    return { ok: false, message: "unsupported effort" };
  }
  const idempotencyKey = optionalIdempotencyKey(body.idempotency_key);
  if (idempotencyKey === "invalid") {
    return { ok: false, message: "idempotency_key must be printable ASCII 1-128" };
  }
  const mergedOnly = optionalBoolean(body.merged_only);
  if (mergedOnly === "invalid") {
    return { ok: false, message: "merged_only must be boolean" };
  }
  return {
    ok: true,
    issue,
    phase,
    provider,
    effort,
    idempotency_key: idempotencyKey,
    merged_only: mergedOnly,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > BODY_MAX_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseBounds(
  params: URLSearchParams,
  allowTailLines: boolean,
):
  | { ok: true; maxBytes: number; cursor: number; tailLines?: number }
  | { ok: false; status: 400 | 413; code: string; message: string } {
  const maxBytes = optionalPositiveIntegerFromText(params.get("max_bytes"));
  if (maxBytes === "invalid") {
    return { ok: false, status: 400, code: "bad_request", message: "invalid max_bytes" };
  }
  const effectiveMax = maxBytes ?? LOG_DIFF_DEFAULT_MAX_BYTES;
  if (effectiveMax > LOG_DIFF_HARD_MAX_BYTES) {
    return { ok: false, status: 413, code: "payload_too_large", message: "max_bytes too large" };
  }
  const cursor = optionalNonNegativeIntegerFromText(params.get("cursor"));
  if (cursor === "invalid") {
    return { ok: false, status: 400, code: "bad_request", message: "invalid cursor" };
  }
  const tailLines = allowTailLines
    ? optionalPositiveIntegerFromText(params.get("tail_lines"))
    : undefined;
  if (tailLines === "invalid") {
    return { ok: false, status: 400, code: "bad_request", message: "invalid tail_lines" };
  }
  return { ok: true, maxBytes: effectiveMax, cursor: cursor ?? 0, tailLines };
}

function boundText(
  value: string,
  maxBytes: number,
  cursor: number,
): { value: string; meta: { truncated: boolean; next_cursor?: string } } {
  const buffer = Buffer.from(value, "utf8");
  const start = normalizeUtf8Cursor(buffer, Math.min(cursor, buffer.length));
  if (buffer.length - start <= maxBytes) {
    return { value: buffer.subarray(start).toString("utf8"), meta: { truncated: false } };
  }
  const end = utf8BoundaryEnd(buffer, start, maxBytes);
  const slice = buffer.subarray(start, end).toString("utf8");
  return {
    value: slice,
    meta: {
      truncated: true,
      next_cursor: String(end),
    },
  };
}

function normalizeUtf8Cursor(buffer: Buffer, cursor: number): number {
  let start = cursor;
  while (start < buffer.length && isUtf8ContinuationByte(buffer[start])) {
    start += 1;
  }
  return start;
}

function utf8BoundaryEnd(buffer: Buffer, start: number, maxBytes: number): number {
  let end = Math.min(buffer.length, start + maxBytes);
  while (end > start && end < buffer.length && isUtf8ContinuationByte(buffer[end])) {
    end -= 1;
  }
  if (end > start) {
    return end;
  }
  end = Math.min(buffer.length, start + 1);
  while (end < buffer.length && isUtf8ContinuationByte(buffer[end])) {
    end += 1;
  }
  return end;
}

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0b1100_0000) === 0b1000_0000;
}

function readLogLines(
  repoRoot: string,
  issue: number,
  config: AutokitConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  const logsDir = join(repoRoot, ".autokit", "logs");
  if (!existsSync(logsDir)) {
    return [];
  }
  return readdirSync(logsDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}(?:-\d+)?\.log$/.test(name))
    .sort()
    .flatMap((name) =>
      readFileSync(join(logsDir, name), "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => sanitizeLogLine(line, issue, config, env, repoRoot)),
    );
}

function sanitizeLogLine(
  line: string,
  issue: number,
  config: AutokitConfig,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): string[] {
  try {
    const parsed = JSON.parse(line) as { issue?: unknown };
    if (parsed.issue !== issue) {
      return [];
    }
    return [JSON.stringify(sanitizeLogValue(parsed, config, env, repoRoot))];
  } catch {
    return [];
  }
}

function sanitizeLogValue(
  value: unknown,
  config: AutokitConfig,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  key?: string,
): unknown {
  if (typeof value === "string") {
    if (key !== undefined && isSensitiveKey(key)) {
      return "<REDACTED>";
    }
    return sanitizeLogString(value, config, false, { homeDir: env.HOME, repoRoot });
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, config, env, repoRoot, key));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, item]) => [
        entryKey,
        sanitizeLogValue(item, config, env, repoRoot, entryKey),
      ]),
    );
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized.includes("privatekey") ||
    normalized.includes("apikey")
  );
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, {
    ok: false,
    code,
    message,
    request_id: randomUUID(),
  });
}

function loadConfig(repoRoot: string): AutokitConfig {
  const path = join(repoRoot, ".autokit", "config.yaml");
  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }
  return parseConfigYaml(readFileSync(path, "utf8"));
}

function loadTasksOrEmpty(repoRoot: string): TasksFile {
  const path = join(repoRoot, ".autokit", "tasks.yaml");
  if (!existsSync(path)) {
    return { version: 1, generated_at: new Date().toISOString(), tasks: [] };
  }
  return loadTasksFile(path);
}

function findTask(repoRoot: string, issue: number): TaskEntry | undefined {
  return loadTasksOrEmpty(repoRoot).tasks.find((task) => task.issue === issue);
}

function hasActiveTaskConflict(repoRoot: string, issue: number | undefined): boolean {
  return loadTasksOrEmpty(repoRoot).tasks.some((task) => {
    if (issue !== undefined && task.issue !== issue) {
      return false;
    }
    return !["queued", "paused", "failed", "merged"].includes(task.state);
  });
}

function findRunByIdempotency(
  dir: string,
  operation: ServeOperation,
  idempotencyKey: string | undefined,
): RunRecord | undefined {
  if (idempotencyKey === undefined || !existsSync(dir)) {
    return undefined;
  }
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const record = readRunRecord(join(dir, name));
    if (record?.operation === operation && record.idempotency_key === idempotencyKey) {
      return record;
    }
  }
  return undefined;
}

function readRunRecord(path: string): RunRecord | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
  } catch {
    return undefined;
  }
}

function markInterruptedRunsResumeRequired(
  env: NodeJS.ProcessEnv,
  stateHomeOverride: string | undefined,
  repoId: string,
  options: AutokitServeOptions,
): void {
  const dir = runsDir(env, stateHomeOverride, repoId);
  if (!existsSync(dir)) {
    return;
  }
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const path = join(dir, name);
    const record = readRunRecord(path);
    if (record?.status !== "accepted" && record?.status !== "running") {
      continue;
    }
    record.status = "resume_required";
    record.updated_at = now(options);
    atomicWriteJson(path, record, 0o600);
  }
}

function findResumeRequiredRun(
  dir: string,
  operation: ServeOperation,
  issue: number | undefined,
): RunRecord | undefined {
  if (!existsSync(dir)) {
    return undefined;
  }
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const record = readRunRecord(join(dir, name));
    if (
      record?.status === "resume_required" &&
      record.operation === operation &&
      (issue === undefined || record.issue === issue)
    ) {
      return record;
    }
  }
  return undefined;
}

function writeRunRecord(
  env: NodeJS.ProcessEnv,
  stateHomeOverride: string | undefined,
  record: RunRecord,
): string {
  const dir = runsDir(env, stateHomeOverride, record.repo_id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `${record.run_id}.json`);
  atomicWriteJson(path, record, 0o600);
  return path;
}

function runsDir(
  env: NodeJS.ProcessEnv,
  stateHomeOverride: string | undefined,
  repoId: string,
): string {
  return join(stateHome(env, stateHomeOverride), "autokit", "runs", repoId);
}

function atomicWriteJson(path: string, value: unknown, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, mode);
}

function writeServeToken(
  stateHomePath: string,
  repoId: string,
  port: number,
  token: string,
): string {
  const dir = join(stateHomePath, "autokit", "serve", repoId, String(port));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, "token");
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, `${token}\n`);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  return path;
}

function repoIdFor(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
}

function stateHome(env: NodeJS.ProcessEnv, override: string | undefined): string {
  return override ?? env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state");
}

function assertAllowedBindHost(host: string): void {
  if (!allowedBindHosts.has(host)) {
    throw new Error(`unsupported serve host: ${host}`);
  }
}

function issueFromPath(path: string, segmentIndex: number): number {
  return Number(path.split("/")[segmentIndex]);
}

function now(options: AutokitServeOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

function optionalPositiveInteger(value: unknown): number | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : "invalid";
}

function optionalBoolean(value: unknown): boolean | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "boolean" ? value : "invalid";
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" && values.includes(value) ? value : "invalid";
}

function optionalIdempotencyKey(value: unknown): string | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" && /^[\x20-\x7e]{1,128}$/.test(value) ? value : "invalid";
}

function optionalPositiveIntegerFromText(value: string | null): number | undefined | "invalid" {
  if (value === null) {
    return undefined;
  }
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : "invalid";
}

function optionalNonNegativeIntegerFromText(value: string | null): number | undefined | "invalid" {
  if (value === null) {
    return undefined;
  }
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : "invalid";
}

function safeTokenEqual(supplied: string, expected: string): boolean {
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

function isAllowedHostHeader(host: string | undefined, port: number): boolean {
  if (host === undefined) {
    return false;
  }
  const normalized = host.toLowerCase();
  return (
    normalized === `127.0.0.1:${port}` ||
    normalized === `localhost:${port}` ||
    normalized === `localhost.:${port}` ||
    normalized === `[::1]:${port}`
  );
}

function isAllowedOriginHeader(origin: string | undefined, port: number): boolean {
  if (origin === undefined) {
    return true;
  }
  if (origin === "null") {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && isAllowedHostHeader(parsed.host, port);
  } catch {
    return false;
  }
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) {
    return false;
  }
  return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}
