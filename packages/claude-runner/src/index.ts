import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type { Readable } from "node:stream";

import {
  type AgentRunInput,
  type AgentRunOutput,
  buildRunnerEnv,
  type FailureCode,
  formatQuestionResponsePrompt,
  type ParentEnv,
  type PromptContractId,
  parsePromptContractYaml,
  promptContractForPhase,
  promptContractJsonSchema,
  type ValidPromptContractPayload,
  validatePromptContractPayload,
} from "@cattyneo/autokit-core";

export const CLAUDE_RUNNER_PACKAGE = "@cattyneo/autokit-claude-runner";

export const claudeRunnerPhases = ["plan", "plan_fix", "review", "supervise"] as const;
export type ClaudeRunnerPhase = (typeof claudeRunnerPhases)[number];

export type ClaudeRunnerEnvOptions = {
  home?: string;
  xdgConfigHome?: string;
  xdgCacheHome?: string;
};

export type ClaudeRunnerDeps = {
  parentEnv?: ParentEnv;
  spawn?: SpawnClaudeProcess;
  command?: string;
  killGraceMs?: number;
};

export type ClaudeAuthProbeOptions = ClaudeRunnerDeps & {
  cwd: string;
  timeoutMs?: number;
};

export type ClaudeAuthProbeResult = {
  ok: true;
  stdout: string;
};

export type SpawnClaudeProcess = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    detached: boolean;
    stdio: ["ignore", "pipe", "pipe"];
  },
) => ClaudeChildProcess;

export type ClaudeChildProcess = {
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "close", listener: (code: number | null) => void): ClaudeChildProcess;
  once(event: "error", listener: (error: Error) => void): ClaudeChildProcess;
};

export class ClaudeRunnerError extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode, message: string) {
    super(message);
    this.name = "ClaudeRunnerError";
    this.code = code;
  }
}

const API_KEY_ENV_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"] as const;
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;
const DENIED_TOOLS = ["Bash", "Edit", "Write", "WebFetch", "WebSearch"] as const;
const DEFAULT_KILL_GRACE_MS = 5_000;

export function assertClaudeRunnerEnv(parentEnv: ParentEnv): void {
  const present = API_KEY_ENV_NAMES.filter(
    (key) => typeof parentEnv[key] === "string" && parentEnv[key] !== "",
  );
  if (present.length > 0) {
    throw new ClaudeRunnerError(
      "other",
      `Claude runner requires subscription auth with API key env unset: ${present.join(", ")}`,
    );
  }
}

export function buildClaudeRunnerEnv(
  parentEnv: ParentEnv,
  options: ClaudeRunnerEnvOptions = {},
): Record<string, string> {
  assertClaudeRunnerEnv(parentEnv);
  return buildRunnerEnv(parentEnv, options);
}

export function buildClaudeAuthProbeArgs(): string[] {
  return ["auth", "status"];
}

export async function probeClaudeSubscriptionAuth(
  options: ClaudeAuthProbeOptions,
): Promise<ClaudeAuthProbeResult> {
  const parentEnv = options.parentEnv ?? process.env;
  const env = buildClaudeRunnerEnv(parentEnv);
  const command = options.command ?? "claude";
  const child = (options.spawn ?? spawnClaudeProcess)(command, buildClaudeAuthProbeArgs(), {
    cwd: options.cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await collectClaudeProcess(
    child,
    options.timeoutMs ?? 30_000,
    options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
  );
  if (result.exitCode !== 0) {
    throw new ClaudeRunnerError(
      "other",
      sanitizeProviderMessage(
        result.stderr.trim() || result.stdout.trim() || "Claude auth probe failed.",
      ),
    );
  }
  return { ok: true, stdout: result.stdout };
}

export function buildClaudeArgs(input: AgentRunInput): string[] {
  assertClaudeInput(input);

  const schema = promptContractJsonSchema(input.promptContract);
  const args = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    READ_ONLY_TOOLS.join(","),
    "--disallowedTools",
    DENIED_TOOLS.join(","),
    "--setting-sources",
    "project",
    "--settings",
    JSON.stringify(buildClaudePathGuardSettings(resolveClaudeWorkspaceRoot(input))),
    "--json-schema",
    JSON.stringify(schema),
  ];

  if (input.model !== "auto") {
    args.push("--model", input.model);
  }

  if (input.resume?.claudeSessionId !== undefined) {
    args.push("--resume", input.resume.claudeSessionId);
  }

  args.push(formatClaudePrompt(input));
  return args;
}

export function parseClaudeCliJson(
  stdout: string,
  contract: PromptContractId = "plan",
): AgentRunOutput {
  const parsed = parseJsonObject(stdout);
  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;
  const resolvedModel = typeof parsed.model === "string" ? parsed.model : undefined;

  if (parsed.is_error === true) {
    const message = String(parsed.result ?? "");
    if (isRateLimitMessage(message)) {
      return {
        status: "rate_limited",
        summary: "Claude runner was rate limited.",
        ...(sessionId === undefined ? {} : { session: { claudeSessionId: sessionId } }),
        ...(resolvedModel === undefined ? {} : { resolvedModel }),
      };
    }
    throw new ClaudeRunnerError(
      "other",
      truncateMessage(message || "Claude CLI returned an error."),
    );
  }

  const payload =
    parsed.structured_output === undefined && typeof parsed.result === "string"
      ? parseYamlPayload(contract, parsed.result)
      : validateJsonPayload(contract, parsed.structured_output);

  return {
    status: payload.status,
    summary: payload.summary,
    ...(payload.data === undefined ? {} : { structured: payload.data }),
    ...(payload.question === undefined ? {} : { question: payload.question }),
    ...(sessionId === undefined ? {} : { session: { claudeSessionId: sessionId } }),
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
  };
}

export async function runClaude(
  input: AgentRunInput,
  deps: ClaudeRunnerDeps = {},
): Promise<AgentRunOutput> {
  const parentEnv = deps.parentEnv ?? process.env;
  const env = buildClaudeRunnerEnv(parentEnv);
  const args = buildClaudeArgs(input);
  const child = (deps.spawn ?? spawnClaudeProcess)(deps.command ?? "claude", args, {
    cwd: input.cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const result = await collectClaudeProcess(
    child,
    input.timeoutMs,
    deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
  );
  const { exitCode, stdout, stderr } = result;
  if (exitCode !== 0) {
    const message = sanitizeProviderMessage(
      stderr.trim() || stdout.trim() || `Claude exited with ${exitCode}`,
    );
    if (isRateLimitMessage(message)) {
      return { status: "rate_limited", summary: "Claude runner was rate limited." };
    }
    throw new ClaudeRunnerError("other", message);
  }

  try {
    return parseClaudeCliJson(stdout, input.promptContract);
  } catch (error) {
    if (error instanceof ClaudeRunnerError) {
      throw error;
    }
    throw new ClaudeRunnerError("prompt_contract_violation", errorToMessage(error));
  }
}

function assertClaudeInput(
  input: AgentRunInput,
): asserts input is AgentRunInput & { phase: ClaudeRunnerPhase } {
  if (input.provider !== "claude") {
    throw new ClaudeRunnerError("other", "Claude runner only accepts provider=claude.");
  }
  if (!isClaudeRunnerPhase(input.phase)) {
    throw new ClaudeRunnerError("other", `Claude runner does not handle phase=${input.phase}.`);
  }
  const expectedContract = promptContractForPhase(input.phase);
  if (input.promptContract !== expectedContract) {
    throw new ClaudeRunnerError(
      "prompt_contract_violation",
      `Claude phase ${input.phase} must use prompt_contract=${expectedContract}.`,
    );
  }
  if (input.permissions.mode !== "readonly") {
    throw new ClaudeRunnerError("sandbox_violation", "Claude runner phases are read-only only.");
  }
  if (input.permissions.allowNetwork) {
    throw new ClaudeRunnerError(
      "network_required",
      "Claude runner phases do not allow network tools.",
    );
  }
  const expectedScope: "repo" | "worktree" =
    input.phase === "plan" || input.phase === "plan_fix" ? "repo" : "worktree";
  if (input.permissions.workspaceScope !== expectedScope) {
    throw new ClaudeRunnerError(
      "sandbox_violation",
      `Claude phase ${input.phase} requires workspaceScope=${expectedScope}.`,
    );
  }
  resolveClaudeWorkspaceRoot(input);
  if (input.timeoutMs <= 0 || !Number.isSafeInteger(input.timeoutMs)) {
    throw new ClaudeRunnerError("runner_timeout", "timeoutMs must be a positive safe integer.");
  }
}

export function validateClaudeToolPathInput(input: {
  tool_name?: unknown;
  tool_input?: unknown;
  workspaceRoot: string;
}): { ok: true } | { ok: false; reason: string } {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (toolName !== "Read" && toolName !== "Grep" && toolName !== "Glob") {
    return { ok: true };
  }
  if (!isRecord(input.tool_input)) {
    return { ok: true };
  }

  const workspaceRoot = safeRealpath(input.workspaceRoot);
  if (workspaceRoot === undefined) {
    return { ok: false, reason: "workspace root is invalid" };
  }
  const pathCandidates = collectToolPathCandidates(input.tool_input);
  for (const candidate of pathCandidates) {
    const resolved = safeRealpath(candidate);
    if (resolved === undefined || !isPathInside(resolved, workspaceRoot)) {
      return { ok: false, reason: `Tool path escapes workspace scope: ${candidate}` };
    }
  }
  const patternCandidates = collectToolPatternCandidates(toolName, input.tool_input);
  for (const candidate of patternCandidates) {
    if (isUnsafeRelativePattern(candidate)) {
      return { ok: false, reason: `Tool pattern escapes workspace scope: ${candidate}` };
    }
  }
  return { ok: true };
}

export function buildClaudePathGuardSettings(workspaceRoot: string): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: READ_ONLY_TOOLS.map((tool) => ({
        matcher: tool,
        hooks: [
          {
            type: "command",
            command: buildClaudePathGuardCommand(workspaceRoot),
          },
        ],
      })),
    },
  };
}

function isClaudeRunnerPhase(phase: string): phase is ClaudeRunnerPhase {
  return (claudeRunnerPhases as readonly string[]).includes(phase);
}

function formatClaudePrompt(input: AgentRunInput): string {
  try {
    return formatQuestionResponsePrompt(input);
  } catch (error) {
    throw new ClaudeRunnerError("prompt_contract_violation", errorToMessage(error));
  }
}

function parseJsonObject(stdout: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!isRecord(parsed)) {
      throw new ClaudeRunnerError(
        "prompt_contract_violation",
        "Claude JSON output must be an object.",
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof ClaudeRunnerError) {
      throw error;
    }
    throw new ClaudeRunnerError("prompt_contract_violation", errorToMessage(error));
  }
}

function validateJsonPayload(
  contract: PromptContractId,
  payload: unknown,
): ValidPromptContractPayload {
  const validation = validatePromptContractPayload(contract, payload);
  if (!validation.ok) {
    throw new ClaudeRunnerError(
      "prompt_contract_violation",
      `Claude structured output violated prompt_contract: ${validation.errors.join("; ")}`,
    );
  }
  return validation.payload;
}

function parseYamlPayload(
  contract: PromptContractId,
  yamlText: string,
): ValidPromptContractPayload {
  const validation = parsePromptContractYaml(contract, yamlText);
  if (!validation.ok) {
    throw new ClaudeRunnerError(
      "prompt_contract_violation",
      `Claude YAML output violated prompt_contract: ${validation.errors.join("; ")}`,
    );
  }
  return validation.payload;
}

function spawnClaudeProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    detached: boolean;
    stdio: ["ignore", "pipe", "pipe"];
  },
): ClaudeChildProcess {
  const env = buildRunnerEnv(options.env);
  return spawn(command, args, { ...options, env });
}

async function collectClaudeProcess(
  child: ClaudeChildProcess,
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
  child: ClaudeChildProcess,
  timeoutMs: number,
  killGraceMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(
        new ClaudeRunnerError("runner_timeout", `Claude runner exceeded ${timeoutMs}ms timeout.`),
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
      reject(new ClaudeRunnerError("other", error.message));
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

function terminateChild(child: ClaudeChildProcess, signal: NodeJS.Signals): void {
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

function resolveClaudeWorkspaceRoot(input: AgentRunInput): string {
  const rawRoot = input.permissions.workspaceRoot ?? input.cwd;
  const root = safeRealpath(rawRoot);
  if (root === undefined) {
    throw new ClaudeRunnerError("sandbox_violation", "Claude workspaceRoot must exist.");
  }
  const cwd = safeRealpath(input.cwd);
  if (cwd === undefined || !isPathInside(cwd, root)) {
    throw new ClaudeRunnerError("sandbox_violation", "Claude cwd must stay inside workspaceRoot.");
  }
  return root;
}

function buildClaudePathGuardCommand(workspaceRoot: string): string {
  const script = `
const fs = require("node:fs");
const root = ${JSON.stringify(workspaceRoot)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input || "{}");
    const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
    if (!["Read", "Grep", "Glob"].includes(toolName)) return;
    const toolInput = event.tool_input && typeof event.tool_input === "object" && !Array.isArray(event.tool_input) ? event.tool_input : {};
    const candidates = [];
    for (const key of ["file_path", "path"]) {
      const value = toolInput[key];
      if (typeof value === "string" && value.length > 0) candidates.push(value);
    }
    const patterns = [];
    if (toolName === "Glob" && typeof toolInput.pattern === "string") patterns.push(toolInput.pattern);
    if (toolName === "Grep" && typeof toolInput.glob === "string") patterns.push(toolInput.glob);
    for (const pattern of patterns) {
      if (pattern.startsWith("/") || pattern.startsWith("~") || pattern.includes("../") || pattern === "..") {
        deny(pattern);
        return;
      }
    }
    const rootReal = fs.realpathSync.native(root);
    for (const candidate of candidates) {
      let resolved;
      try { resolved = fs.realpathSync.native(candidate); } catch { deny(candidate); return; }
      if (resolved !== rootReal && !resolved.startsWith(rootReal + "/")) { deny(candidate); return; }
    }
  } catch {
    deny("invalid hook input");
  }
});
function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "sandbox_violation: " + reason } }));
}
`;
  return `node -e ${JSON.stringify(script)}`;
}

function collectToolPathCandidates(toolInput: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  for (const key of ["file_path", "path"]) {
    const value = toolInput[key];
    if (typeof value === "string" && value.length > 0) {
      candidates.push(value);
    }
  }
  return candidates;
}

function collectToolPatternCandidates(
  toolName: string,
  toolInput: Record<string, unknown>,
): string[] {
  const candidates: string[] = [];
  if (toolName === "Glob" && typeof toolInput.pattern === "string") {
    candidates.push(toolInput.pattern);
  }
  if (toolName === "Grep" && typeof toolInput.glob === "string") {
    candidates.push(toolInput.glob);
  }
  return candidates;
}

function isUnsafeRelativePattern(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || value.includes("../") || value === "..";
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

function isRateLimitMessage(message: string): boolean {
  return /(?:rate[_ -]?limit|429|too many requests)/i.test(message);
}

function truncateMessage(message: string): string {
  return message.length <= 2048 ? message : `${message.slice(0, 2048)}...truncated`;
}

function sanitizeProviderMessage(message: string): string {
  const sanitized = message
    .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._:-]+/gi, "Authorization: Bearer <REDACTED>")
    .replace(/Bearer\s+[A-Za-z0-9._:-]+/gi, "Bearer <REDACTED>")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "<REDACTED>")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "<REDACTED>")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "<REDACTED>")
    .replace(/"private_key":\s*"[^"]+"/g, '"private_key":"<REDACTED>"')
    .replace(/\/Users\/[^/\s]+/g, "<workspace>");
  return truncateMessage(sanitized);
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
