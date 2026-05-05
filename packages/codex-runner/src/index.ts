import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  type AgentRunInput,
  type AgentRunOutput,
  buildRunnerEnv,
  type FailureCode,
  formatQuestionResponsePrompt,
  type ParentEnv,
  type PromptContractId,
  promptContractForPhase,
  type ValidPromptContractPayload,
  validatePromptContractPayload,
} from "@cattyneo/autokit-core";

export const CODEX_RUNNER_PACKAGE = "@cattyneo/autokit-codex-runner";

export const codexRunnerPhases = ["plan_verify", "implement", "fix"] as const;
export type CodexRunnerPhase = (typeof codexRunnerPhases)[number];

export type CodexRunnerEnvOptions = {
  home?: string;
  xdgConfigHome?: string;
  xdgCacheHome?: string;
};

export type CodexRunnerDeps = {
  parentEnv?: ParentEnv;
  spawn?: SpawnCodexProcess;
  command?: string;
  createRunFiles?: CreateCodexRunFiles;
  readOutputFile?: (path: string) => string;
  envOptions?: CodexRunnerEnvOptions;
  killGraceMs?: number;
};

export type CodexAuthProbeOptions = CodexRunnerDeps & {
  cwd: string;
  timeoutMs?: number;
};

export type CodexAuthProbeResult = {
  ok: true;
  authMode: "chatgpt";
  summary: string;
};

export type CodexRunFiles = {
  schemaFile: string;
  outputFile: string;
  cleanup(): void;
};

export type CreateCodexRunFiles = (
  contract: PromptContractId,
  schema: Record<string, unknown>,
) => CodexRunFiles;

export type SpawnCodexProcess = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    detached: boolean;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => CodexChildProcess;

export type CodexChildProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "close", listener: (code: number | null) => void): CodexChildProcess;
  once(event: "error", listener: (error: Error) => void): CodexChildProcess;
};

export class CodexRunnerError extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode, message: string) {
    super(message);
    this.name = "CodexRunnerError";
    this.code = code;
  }
}

const API_KEY_ENV_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"] as const;
const DEFAULT_KILL_GRACE_MS = 5_000;

export function assertCodexRunnerEnv(parentEnv: ParentEnv): void {
  const present = API_KEY_ENV_NAMES.filter(
    (key) => typeof parentEnv[key] === "string" && parentEnv[key] !== "",
  );
  if (present.length > 0) {
    throw new CodexRunnerError(
      "other",
      `Codex runner requires ChatGPT-managed auth with API key env unset: ${present.join(", ")}`,
    );
  }
}

export function buildCodexRunnerEnv(
  parentEnv: ParentEnv,
  options: CodexRunnerEnvOptions = {},
): Record<string, string> {
  assertCodexRunnerEnv(parentEnv);
  return buildRunnerEnv(parentEnv, options);
}

export function buildCodexAuthProbeArgs(): string[] {
  return ["login", "status"];
}

export async function probeCodexChatGptAuth(
  options: CodexAuthProbeOptions,
): Promise<CodexAuthProbeResult> {
  const parentEnv = options.parentEnv ?? process.env;
  const env = buildCodexRunnerEnv(parentEnv, options.envOptions);
  const command = options.command ?? "codex";
  const child = (options.spawn ?? spawnCodexProcess)(command, buildCodexAuthProbeArgs(), {
    cwd: options.cwd,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  const result = await collectCodexProcess(
    child,
    options.timeoutMs ?? 30_000,
    options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
  );
  const output = sanitizeProviderMessage(`${result.stdout}\n${result.stderr}`.trim());
  if (result.exitCode !== 0) {
    throw new CodexRunnerError("other", output || "Codex auth probe failed.");
  }
  if (!isChatGptAuthSummary(result.stdout, result.stderr)) {
    throw new CodexRunnerError(
      "other",
      "Codex auth mode is not confirmed as ChatGPT-managed auth.",
    );
  }
  return { ok: true, authMode: "chatgpt", summary: output };
}

export function buildCodexArgs(input: AgentRunInput, files: CodexRunFiles): string[] {
  assertCodexInput(input);

  const sandbox = sandboxForPhase(input.phase);
  const args = [
    "-a",
    "never",
    "--sandbox",
    sandbox,
    ...(input.phase === "plan_verify" ? ["--disable", "shell_tool"] : []),
    ...(input.model === "auto" ? [] : ["--model", input.model]),
    "exec",
  ];

  if (input.resume?.codexSessionId !== undefined) {
    args.push("resume", input.resume.codexSessionId);
  }

  args.push("--json", "--ignore-user-config", "--ignore-rules", "-o", files.outputFile);

  if (input.resume?.codexSessionId === undefined) {
    args.push("--output-schema", files.schemaFile);
  }

  args.push("-");
  return args;
}

export function parseCodexJsonl(stdout: string): { codexSessionId: string } {
  const events = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (events.length === 0) {
    throw new CodexRunnerError("prompt_contract_violation", "Codex JSONL output is empty.");
  }

  let codexSessionId: string | undefined;
  for (const [index, line] of events.entries()) {
    const event = parseJsonObject(line, `Codex JSONL line ${index + 1}`);
    validateCodexJsonlEvent(event, index + 1);
    const threadId = event.thread_id;
    if (typeof threadId === "string" && threadId.length > 0) {
      if (codexSessionId !== undefined && codexSessionId !== threadId) {
        throw new CodexRunnerError(
          "prompt_contract_violation",
          "Codex JSONL thread_id changed within one run.",
        );
      }
      codexSessionId = threadId;
    }
  }

  if (codexSessionId === undefined) {
    throw new CodexRunnerError("prompt_contract_violation", "Codex JSONL omitted thread_id.");
  }
  return { codexSessionId };
}

export function parseCodexFinalOutput(
  text: string,
  contract: PromptContractId,
): ValidPromptContractPayload {
  const payload = normalizeCodexFinalPayload(parseJsonObject(text, "Codex final output"));
  const validation = validatePromptContractPayload(contract, payload);
  if (!validation.ok) {
    throw new CodexRunnerError(
      "prompt_contract_violation",
      `Codex final output violated prompt_contract: ${validation.errors.join("; ")}`,
    );
  }
  return validation.payload;
}

export async function runCodex(
  input: AgentRunInput,
  deps: CodexRunnerDeps = {},
): Promise<AgentRunOutput> {
  const parentEnv = deps.parentEnv ?? process.env;
  await probeCodexChatGptAuth({
    cwd: input.cwd,
    parentEnv,
    spawn: deps.spawn,
    command: deps.command,
    timeoutMs: input.timeoutMs,
    envOptions: deps.envOptions,
    killGraceMs: deps.killGraceMs,
  });
  const env = buildCodexRunnerEnv(parentEnv, deps.envOptions);
  const schema = codexPromptContractJsonSchema(input.promptContract);
  const files = (deps.createRunFiles ?? createCodexRunFiles)(input.promptContract, schema);
  try {
    const args = buildCodexArgs(input, files);
    const child = (deps.spawn ?? spawnCodexProcess)(deps.command ?? "codex", args, {
      cwd: input.cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(formatCodexPrompt(input));

    const result = await collectCodexProcess(
      child,
      input.timeoutMs,
      deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    );
    if (result.exitCode !== 0) {
      return parseFailedCodexExit(result);
    }

    const { codexSessionId } = parseCodexJsonl(result.stdout);
    const readOutputFile = deps.readOutputFile ?? ((path: string) => readFileSync(path, "utf8"));
    const payload = parseCodexFinalOutput(readOutputFile(files.outputFile), input.promptContract);
    return {
      status: payload.status,
      summary: payload.summary,
      ...(payload.data === undefined ? {} : { structured: payload.data }),
      ...(payload.question === undefined ? {} : { question: payload.question }),
      session: { codexSessionId },
    };
  } finally {
    files.cleanup();
  }
}

function assertCodexInput(
  input: AgentRunInput,
): asserts input is AgentRunInput & { phase: CodexRunnerPhase } {
  if (input.provider !== "codex") {
    throw new CodexRunnerError("other", "Codex runner only accepts provider=codex.");
  }
  if (!isCodexRunnerPhase(input.phase)) {
    throw new CodexRunnerError("other", `Codex runner does not handle phase=${input.phase}.`);
  }
  const expectedContract = promptContractForPhase(input.phase);
  if (input.promptContract !== expectedContract) {
    throw new CodexRunnerError(
      "prompt_contract_violation",
      `Codex phase ${input.phase} must use prompt_contract=${expectedContract}.`,
    );
  }
  const expectedMode = input.phase === "plan_verify" ? "readonly" : "workspace-write";
  if (input.permissions.mode !== expectedMode) {
    throw new CodexRunnerError(
      "sandbox_violation",
      `Codex phase ${input.phase} requires permissions.mode=${expectedMode}.`,
    );
  }
  if (input.permissions.allowNetwork) {
    throw new CodexRunnerError("network_required", "Codex runner phases do not allow network.");
  }
  const expectedScope = input.phase === "plan_verify" ? "repo" : "worktree";
  if (input.permissions.workspaceScope !== expectedScope) {
    throw new CodexRunnerError(
      "sandbox_violation",
      `Codex phase ${input.phase} requires workspaceScope=${expectedScope}.`,
    );
  }
  resolveCodexWorkspaceRoot(input);
  if (input.timeoutMs <= 0 || !Number.isSafeInteger(input.timeoutMs)) {
    throw new CodexRunnerError("runner_timeout", "timeoutMs must be a positive safe integer.");
  }
}

function isCodexRunnerPhase(phase: string): phase is CodexRunnerPhase {
  return (codexRunnerPhases as readonly string[]).includes(phase);
}

function sandboxForPhase(phase: CodexRunnerPhase): "read-only" | "workspace-write" {
  return phase === "plan_verify" ? "read-only" : "workspace-write";
}

function formatCodexPrompt(input: AgentRunInput): string {
  try {
    return formatQuestionResponsePrompt(input);
  } catch (error) {
    throw new CodexRunnerError("prompt_contract_violation", errorToMessage(error));
  }
}

function parseFailedCodexExit(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): AgentRunOutput {
  const message = sanitizeProviderMessage(
    result.stderr.trim() || result.stdout.trim() || `Codex exited with ${result.exitCode}`,
  );
  if (isRateLimitMessage(message)) {
    return { status: "rate_limited", summary: "Codex runner was rate limited." };
  }
  if (isApprovalOrSandboxMessage(message)) {
    throw new CodexRunnerError("sandbox_violation", message);
  }
  throw new CodexRunnerError("other", message);
}

function validateCodexJsonlEvent(event: Record<string, unknown>, lineNumber: number): void {
  const serialized = JSON.stringify(event).toLowerCase();
  if (serialized.includes("approval") || serialized.includes("escalat")) {
    throw new CodexRunnerError(
      "sandbox_violation",
      `Codex JSONL line ${lineNumber} requested approval.`,
    );
  }
  if (serialized.includes("sandbox") && serialized.includes("denied")) {
    throw new CodexRunnerError(
      "sandbox_violation",
      `Codex JSONL line ${lineNumber} reported a sandbox denial.`,
    );
  }
  if (!hasRecognizedCodexEventShape(event)) {
    throw new CodexRunnerError(
      "prompt_contract_violation",
      `Codex JSONL line ${lineNumber} has an unrecognized event shape.`,
    );
  }
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      throw new CodexRunnerError("prompt_contract_violation", `${label} must be an object.`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof CodexRunnerError) {
      throw error;
    }
    throw new CodexRunnerError("prompt_contract_violation", errorToMessage(error));
  }
}

function createCodexRunFiles(
  contract: PromptContractId,
  schema: Record<string, unknown>,
): CodexRunFiles {
  const directory = mkdtempSync(join(tmpdir(), `autokit-codex-${contract}-`));
  const schemaFile = join(directory, "schema.json");
  const outputFile = join(directory, "last-message.json");
  writeFileSync(schemaFile, `${JSON.stringify(schema)}\n`, { mode: 0o600 });
  return {
    schemaFile,
    outputFile,
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function codexPromptContractJsonSchema(contract: PromptContractId): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed", "need_input", "paused", "failed"] },
      summary: { type: "string", maxLength: 16 * 1024 },
      data: {
        anyOf: [
          dataJsonSchemaForCodex(contract),
          pausedOrFailedDataJsonSchema(true),
          { type: "null" },
        ],
      },
      question: {
        anyOf: [
          objectSchema({
            text: { type: "string", maxLength: 16 * 1024 },
            default: { type: "string", maxLength: 16 * 1024 },
          }),
          { type: "null" },
        ],
      },
    },
    required: ["status", "summary", "data", "question"],
    additionalProperties: false,
  };
}

function dataJsonSchemaForCodex(contract: PromptContractId): Record<string, unknown> {
  switch (contract) {
    case "plan":
      return objectSchema({
        plan_markdown: { type: "string", maxLength: 64 * 1024 },
        assumptions: stringArraySchema(20),
        risks: stringArraySchema(20),
      });
    case "plan-verify":
      return {
        anyOf: [
          objectSchema({
            result: { type: "string", enum: ["ok"] },
            findings: planVerifyFindingsArraySchema(0),
          }),
          objectSchema({
            result: { type: "string", enum: ["ng"] },
            findings: planVerifyFindingsArraySchema(20),
          }),
        ],
      };
    case "plan-fix":
      return objectSchema({
        plan_markdown: { type: "string", maxLength: 64 * 1024 },
        addressed_findings: stringArraySchema(20),
      });
    case "implement":
      return objectSchema({
        changed_files: stringArraySchema(200),
        tests_run: testEvidenceArraySchema(),
        docs_updated: { type: "boolean" },
        notes: { type: "string", maxLength: 16 * 1024 },
      });
    case "review":
      return objectSchema({
        findings: {
          type: "array",
          items: objectSchema({
            severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
            file: { type: "string", maxLength: 16 * 1024, pattern: "^(?!/|~|\\.\\.?($|/)).+" },
            line: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
            title: { type: "string", maxLength: 16 * 1024 },
            rationale: { type: "string", maxLength: 16 * 1024 },
            suggested_fix: { type: "string", maxLength: 16 * 1024 },
          }),
          maxItems: 50,
        },
      });
    case "supervise":
      return objectSchema({
        accept_ids: stringArraySchema(50),
        reject_ids: stringArraySchema(50),
        reject_reasons: { type: "object", additionalProperties: { type: "string" } },
        fix_prompt: { type: "string", maxLength: 32 * 1024 },
      });
    case "fix":
      return objectSchema({
        changed_files: stringArraySchema(200),
        tests_run: testEvidenceArraySchema(),
        resolved_accept_ids: stringArraySchema(50),
        unresolved_accept_ids: stringArraySchema(50),
        notes: { type: "string", maxLength: 16 * 1024 },
      });
  }
}

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function stringArraySchema(maxItems: number): Record<string, unknown> {
  return { type: "array", items: { type: "string", maxLength: 16 * 1024 }, maxItems };
}

function testEvidenceArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    items: objectSchema({
      command: { type: "string", maxLength: 16 * 1024 },
      result: { type: "string", enum: ["passed", "failed", "skipped"] },
      summary: { type: "string", maxLength: 16 * 1024 },
    }),
    maxItems: 20,
  };
}

function planVerifyFindingsArraySchema(maxItems: number): Record<string, unknown> {
  return {
    type: "array",
    items: objectSchema({
      severity: { type: "string", enum: ["blocker", "major", "minor"] },
      title: { type: "string", maxLength: 16 * 1024 },
      rationale: { type: "string", maxLength: 16 * 1024 },
      required_change: { type: "string", maxLength: 16 * 1024 },
    }),
    maxItems,
  };
}

function pausedOrFailedDataJsonSchema(withRecoverable: boolean): Record<string, unknown> {
  return objectSchema(
    withRecoverable
      ? {
          reason: { type: "string", maxLength: 16 * 1024 },
          recoverable: { type: "boolean" },
        }
      : {
          reason: { type: "string", maxLength: 16 * 1024 },
        },
  );
}

function normalizeCodexFinalPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...payload };
  if (normalized.data === null) {
    delete normalized.data;
  }
  if (normalized.question === null) {
    delete normalized.question;
  }
  return normalized;
}

function spawnCodexProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    detached: boolean;
    stdio: ["pipe", "pipe", "pipe"];
  },
): CodexChildProcess {
  const env = buildRunnerEnv(options.env);
  return spawn(command, args, { ...options, env });
}

async function collectCodexProcess(
  child: CodexChildProcess,
  timeoutMs: number,
  killGraceMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await waitForChild(child, timeoutMs, killGraceMs);
  return { exitCode, stdout, stderr };
}

function waitForChild(
  child: CodexChildProcess,
  timeoutMs: number,
  killGraceMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(
        new CodexRunnerError("runner_timeout", `Codex runner exceeded ${timeoutMs}ms timeout.`),
      );
      terminateChild(child, "SIGTERM");
      killTimer = setTimeout(() => {
        terminateChild(child, "SIGKILL");
      }, killGraceMs);
    }, timeoutMs);

    child.once("error", (error) => {
      if (timedOut) {
        return;
      }
      clearTimeout(timer);
      clearTimeoutIfDefined(killTimer);
      reject(new CodexRunnerError("other", sanitizeProviderMessage(error.message)));
    });
    child.once("close", (code) => {
      clearTimeoutIfDefined(killTimer);
      if (timedOut) {
        return;
      }
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function terminateChild(child: CodexChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child as a best-effort cleanup path.
    }
  }
  child.kill(signal);
}

function clearTimeoutIfDefined(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

function resolveCodexWorkspaceRoot(input: AgentRunInput): string {
  const rawRoot = input.permissions.workspaceRoot ?? input.cwd;
  const root = safeRealpath(rawRoot);
  if (root === undefined) {
    throw new CodexRunnerError("sandbox_violation", "Codex workspaceRoot must exist.");
  }
  const cwd = safeRealpath(input.cwd);
  if (cwd === undefined || !isPathInside(cwd, root)) {
    throw new CodexRunnerError("sandbox_violation", "Codex cwd must stay inside workspaceRoot.");
  }
  return root;
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function isPathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function isChatGptAuthSummary(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (
    text.includes("api key") ||
    text.includes("openai_api_key") ||
    text.includes("codex_api_key")
  ) {
    return false;
  }
  return text.includes("chatgpt") || text.includes("chat gpt") || text.includes("subscription");
}

function hasRecognizedCodexEventShape(event: Record<string, unknown>): boolean {
  const eventType = event.type;
  if (typeof eventType === "string" && !isRecognizedCodexEventType(eventType)) {
    return false;
  }
  if ("item" in event) {
    if (!isRecord(event.item)) {
      return false;
    }
    const itemType = event.item.type;
    if (typeof itemType !== "string" || !isRecognizedCodexItemType(itemType)) {
      return false;
    }
  }
  if ("usage" in event && !isRecord(event.usage)) {
    return false;
  }
  return (
    typeof event.thread_id === "string" ||
    isRecognizedCodexEventType(eventType) ||
    "item" in event ||
    "usage" in event
  );
}

function isRecognizedCodexEventType(value: unknown): value is string {
  return (
    value === "thread.started" ||
    value === "turn.started" ||
    value === "item.started" ||
    value === "item.completed" ||
    value === "turn.completed" ||
    value === "turn.failed" ||
    value === "error"
  );
}

function isRecognizedCodexItemType(value: string): boolean {
  return (
    value === "agent_message" ||
    value === "error" ||
    value === "file_change" ||
    value === "reasoning" ||
    value === "command_execution" ||
    value === "tool_call"
  );
}

function isApprovalOrSandboxMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("approval") ||
    normalized.includes("escalat") ||
    (normalized.includes("sandbox") && normalized.includes("denied"))
  );
}

function isRateLimitMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("rate limit") || normalized.includes("429");
}

function sanitizeProviderMessage(message: string): string {
  return truncateMessage(
    message
      .replace(
        /-----BEGIN [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)[\s\S]*?-----END [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----/g,
        "<REDACTED_PRIVATE_KEY>",
      )
      .replace(/Authorization:\s*\S+(?:\s+\S+)?/gi, "Authorization: <REDACTED>")
      .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi, "Authorization: Bearer <REDACTED>")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <REDACTED>")
      .replace(/ghp_[A-Za-z0-9_]{20,}/g, "ghp_<REDACTED>")
      .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_<REDACTED>")
      .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-<REDACTED>")
      .replace(
        /\b(access_token|refresh_token|id_token|token)\b["']?\s*[:=]\s*["']?[^"',\s}]+["']?/gi,
        '$1="<REDACTED>"',
      )
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "AWS_ACCESS_KEY_ID_<REDACTED>")
      .replace(/private_key["']?\s*[:=]\s*["'][^"']+["']/gi, 'private_key="<REDACTED>"')
      .replace(/\/Users\/[^/\s]+/g, "<workspace>"),
  );
}

function truncateMessage(message: string): string {
  return message.length > 2_048 ? `${message.slice(0, 2_045)}...` : message;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
