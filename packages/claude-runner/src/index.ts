import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

import {
  type AgentRunInput,
  type AgentRunOutput,
  buildRunnerEnv,
  type ClaudeHook,
  type ClaudePermission,
  DEFAULT_CONFIG,
  derive_claude_perm,
  type FailureCode,
  formatQuestionResponsePrompt,
  type ParentEnv,
  type PermissionProfile,
  type PromptContractId,
  parsePromptContractYaml,
  promptContractForPhase,
  promptContractJsonSchema,
  sanitizeLogString,
  type ValidPromptContractPayload,
  validateCapabilitySelection,
  validateGuardedCommand,
  validatePathAccess,
  validatePromptContractPayload,
} from "@cattyneo/autokit-core";

export const CLAUDE_RUNNER_PACKAGE = "@cattyneo/autokit-claude-runner";

export type ClaudeRunnerEnvOptions = {
  home?: string;
  xdgConfigHome?: string;
  xdgCacheHome?: string;
  ghConfigDir?: string;
  gitConfigGlobal?: string;
  gitConfigNoSystem?: string;
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

export type ClaudePromptPolicy = "concise" | "default" | "detailed";

export type ClaudeEffortProfile = {
  effort: "auto" | "low" | "medium" | "high";
  model: string | undefined;
  maxTurns: number;
  timeoutMs: number;
  promptPolicy: ClaudePromptPolicy;
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
  const env = buildRunnerEnv(parentEnv, options);
  if (options.ghConfigDir !== undefined) {
    env.GH_CONFIG_DIR = options.ghConfigDir;
  }
  if (options.gitConfigGlobal !== undefined) {
    env.GIT_CONFIG_GLOBAL = options.gitConfigGlobal;
  }
  if (options.gitConfigNoSystem !== undefined) {
    env.GIT_CONFIG_NOSYSTEM = options.gitConfigNoSystem;
  }
  return env;
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

  const permission = claudePermissionForInput(input);
  const effortProfile = buildClaudeEffortProfile(input);
  const schema = promptContractJsonSchema(input.promptContract);
  const args = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    permission.allowed_tools.join(","),
    "--disallowedTools",
    permission.denied_tools.join(","),
    "--setting-sources",
    "project",
    "--settings",
    JSON.stringify(
      buildClaudePathGuardSettings(resolveClaudeWorkspaceRoot(input), permission.hook),
    ),
    "--json-schema",
    JSON.stringify(schema),
  ];

  if (effortProfile.model !== undefined) {
    args.push("--model", effortProfile.model);
  }

  if (input.resume?.claudeSessionId !== undefined) {
    args.push("--resume", input.resume.claudeSessionId);
  }

  args.push(formatClaudePrompt(input));
  return args;
}

export function buildClaudeEffortProfile(input: AgentRunInput): ClaudeEffortProfile {
  assertClaudeEffort(input);
  const effort = input.effort;
  if (effort === undefined) {
    throw new ClaudeRunnerError("other", `Claude phase ${input.phase} requires resolved effort.`);
  }
  const explicitModel = input.model === "auto" ? undefined : input.model;
  switch (effort.effort) {
    case "auto":
      return {
        effort: "auto",
        model: explicitModel,
        maxTurns: 16,
        timeoutMs: effort.timeout_ms,
        promptPolicy: "default",
      };
    case "low":
      return {
        effort: "low",
        model: explicitModel ?? "sonnet",
        maxTurns: 8,
        timeoutMs: effort.timeout_ms,
        promptPolicy: "concise",
      };
    case "medium":
      return {
        effort: "medium",
        model: explicitModel ?? "sonnet",
        maxTurns: 16,
        timeoutMs: effort.timeout_ms,
        promptPolicy: "default",
      };
    case "high":
      return {
        effort: "high",
        model: explicitModel ?? "opus",
        maxTurns: 32,
        timeoutMs: effort.timeout_ms,
        promptPolicy: "detailed",
      };
  }
}

export function parseClaudeCliJson(
  stdout: string,
  contract: PromptContractId = "plan",
): AgentRunOutput {
  const parsed = parseJsonObject(stdout);
  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;
  const resolvedModel = typeof parsed.model === "string" ? parsed.model : undefined;

  if (parsed.is_error === true) {
    const message = sanitizeProviderMessage(String(parsed.result ?? ""));
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
  const env = buildClaudeExecutionEnv(parentEnv, input);
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

function assertClaudeInput(input: AgentRunInput): void {
  if (input.provider !== "claude") {
    throw new ClaudeRunnerError("other", "Claude runner only accepts provider=claude.");
  }
  const row = validateCapabilitySelection({ phase: input.phase, provider: input.provider });
  const expectedPermission = derive_claude_perm(input.phase);
  assertClaudeEffort(input);
  const effort = input.effort;
  if (effort === undefined) {
    throw new ClaudeRunnerError("other", `Claude phase ${input.phase} requires resolved effort.`);
  }
  assertClaudeEffectivePermission(input, row.permission_profile);
  const actualPermission = claudePermissionForInput(input);
  if (!isClaudePermissionWithinCap(actualPermission, expectedPermission)) {
    throw new ClaudeRunnerError(
      "sandbox_violation",
      `Claude phase ${input.phase} permission exceeds capability hard cap.`,
    );
  }
  const expectedContract = promptContractForPhase(input.phase);
  if (input.promptContract !== expectedContract) {
    throw new ClaudeRunnerError(
      "prompt_contract_violation",
      `Claude phase ${input.phase} must use prompt_contract=${expectedContract}.`,
    );
  }
  const expectedMode = row.permission_profile === "write_worktree" ? "workspace-write" : "readonly";
  if (input.permissions.mode !== expectedMode) {
    throw new ClaudeRunnerError(
      "sandbox_violation",
      `Claude phase ${input.phase} requires permissions.mode=${expectedMode}.`,
    );
  }
  if (input.permissions.allowNetwork) {
    throw new ClaudeRunnerError(
      "network_required",
      "Claude runner phases do not allow network tools.",
    );
  }
  const expectedScope: "repo" | "worktree" =
    row.permission_profile === "readonly_repo" ? "repo" : "worktree";
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
  if (input.timeoutMs !== effort.timeout_ms) {
    throw new ClaudeRunnerError(
      "runner_timeout",
      `Claude phase ${input.phase} timeoutMs must match resolved effort timeout_ms.`,
    );
  }
}

function claudePermissionForInput(input: AgentRunInput): ClaudePermission {
  return input.effective_permission?.claude ?? derive_claude_perm(input.phase);
}

function assertClaudeEffort(input: AgentRunInput): void {
  if (input.effort === undefined) {
    throw new ClaudeRunnerError("other", `Claude phase ${input.phase} requires resolved effort.`);
  }
  if (input.effort.phase !== input.phase || input.effort.provider !== "claude") {
    throw new ClaudeRunnerError("other", `Claude phase ${input.phase} resolved effort drift.`);
  }
}

function assertClaudeEffectivePermission(
  input: AgentRunInput,
  expectedProfile: PermissionProfile,
): void {
  if (input.effective_permission === undefined || input.effective_permission.claude === undefined) {
    throw new ClaudeRunnerError(
      "sandbox_violation",
      `Claude phase ${input.phase} requires effective permission.`,
    );
  }
  if (input.effective_permission.permission_profile !== expectedProfile) {
    throw new ClaudeRunnerError(
      "sandbox_violation",
      `Claude phase ${input.phase} permission_profile drift.`,
    );
  }
}

function isClaudePermissionWithinCap(actual: ClaudePermission, cap: ClaudePermission): boolean {
  return (
    actual.hook === cap.hook &&
    actual.allowed_tools.every((tool) => cap.allowed_tools.includes(tool)) &&
    cap.denied_tools.every((tool) => actual.denied_tools.includes(tool))
  );
}

export function validateClaudeToolPathInput(input: {
  tool_name?: unknown;
  tool_input?: unknown;
  workspaceRoot: string;
}): { ok: true } | { ok: false; reason: string } {
  const result = validateClaudeToolUseInput({
    hook: "readonly_path_guard",
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    workspaceRoot: input.workspaceRoot,
  });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

export function validateClaudeToolUseInput(input: {
  hook: ClaudeHook;
  tool_name?: unknown;
  tool_input?: unknown;
  workspaceRoot: string;
}): { ok: true; updatedInput?: Record<string, unknown> } | { ok: false; reason: string } {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!isRecord(input.tool_input)) {
    return { ok: true };
  }

  const workspaceRoot = safeRealpath(input.workspaceRoot) ?? input.workspaceRoot;
  if (workspaceRoot.length === 0) {
    return { ok: false, reason: "workspace root is invalid" };
  }

  if (toolName === "Edit" || toolName === "Write") {
    if (input.hook !== "write_path_guard") {
      return { ok: false, reason: `${toolName} is denied for read-only Claude phases` };
    }
    return validateToolPaths(toolName, input.tool_input, workspaceRoot, "write");
  }

  if (toolName === "Bash") {
    if (input.hook !== "write_path_guard") {
      return { ok: false, reason: "Bash is denied for read-only Claude phases" };
    }
    const command = typeof input.tool_input.command === "string" ? input.tool_input.command : "";
    const decision = validateGuardedCommand({
      workspaceRoot,
      command,
      packageScripts: readPackageScripts(workspaceRoot),
    });
    if (!decision.ok) {
      return { ok: false, reason: decision.reason };
    }
    return {
      ok: true,
      updatedInput: {
        ...input.tool_input,
        command: buildGuardedCommandRunnerCommand(workspaceRoot, command),
      },
    };
  }

  if (toolName === "Read" || toolName === "Grep" || toolName === "Glob") {
    return validateToolPaths(toolName, input.tool_input, workspaceRoot, "read");
  }
  return { ok: true };
}

function validateToolPaths(
  toolName: string,
  toolInput: Record<string, unknown>,
  workspaceRoot: string,
  access: "read" | "write",
): { ok: true } | { ok: false; reason: string } {
  const pathCandidates = collectToolPathCandidates(toolInput);
  for (const candidate of pathCandidates) {
    const decision = validatePathAccess({ workspaceRoot, candidate, access });
    if (!decision.ok) {
      return decision;
    }
  }
  const patternCandidates = collectToolPatternCandidates(toolName, toolInput);
  for (const candidate of patternCandidates) {
    if (isUnsafeRelativePattern(candidate)) {
      return { ok: false, reason: `Tool pattern escapes workspace scope: ${candidate}` };
    }
    const decision = validatePathAccess({ workspaceRoot, candidate, access: "read" });
    if (!decision.ok) {
      return decision;
    }
  }
  return { ok: true };
}

export function buildClaudePathGuardSettings(
  workspaceRoot: string,
  hook: ClaudeHook = "readonly_path_guard",
): Record<string, unknown> {
  const matchers =
    hook === "write_path_guard" ? ["Read|Grep|Glob|Edit|Write|Bash"] : ["Read|Grep|Glob"];
  return {
    hooks: {
      PreToolUse: matchers.map((matcher) => ({
        matcher,
        hooks: [
          {
            type: "command",
            command: buildClaudePathGuardCommand(workspaceRoot, hook),
          },
        ],
      })),
    },
  };
}

function formatClaudePrompt(input: AgentRunInput): string {
  try {
    const prompt = formatQuestionResponsePrompt(input);
    return `${formatClaudeEffortProfilePrompt(buildClaudeEffortProfile(input))}\n\n${prompt}`;
  } catch (error) {
    throw new ClaudeRunnerError("prompt_contract_violation", errorToMessage(error));
  }
}

function formatClaudeEffortProfilePrompt(profile: ClaudeEffortProfile): string {
  const policyInstruction =
    profile.promptPolicy === "concise"
      ? "Keep the response focused and stop as soon as the prompt_contract output can be produced."
      : profile.promptPolicy === "detailed"
        ? "Use the additional turn budget for careful verification before producing the prompt_contract output."
        : "Use the default level of detail and produce the prompt_contract output when ready.";
  return [
    "<autokit-effort-profile>",
    `effort: ${profile.effort}`,
    `max_turns: ${profile.maxTurns}`,
    `timeout_ms: ${profile.timeoutMs}`,
    `prompt_policy: ${profile.promptPolicy}`,
    `instruction: ${policyInstruction}`,
    "</autokit-effort-profile>",
  ].join("\n");
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
  const env = buildRunnerEnv(options.env, {
    home: options.env.HOME,
    xdgConfigHome: options.env.XDG_CONFIG_HOME,
    xdgCacheHome: options.env.XDG_CACHE_HOME,
  });
  copyIfDefined(env, options.env, "GH_CONFIG_DIR");
  copyIfDefined(env, options.env, "GIT_CONFIG_GLOBAL");
  copyIfDefined(env, options.env, "GIT_CONFIG_NOSYSTEM");
  return spawn(command, args, { ...options, env });
}

function copyIfDefined(
  env: Record<string, string>,
  source: Record<string, string>,
  key: string,
): void {
  if (source[key] !== undefined) {
    env[key] = source[key];
  }
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

function buildClaudeExecutionEnv(
  parentEnv: ParentEnv,
  input: AgentRunInput,
): Record<string, string> {
  const permission = claudePermissionForInput(input);
  if (permission.hook !== "write_path_guard" && input.permissions.homeIsolation !== "isolated") {
    return buildClaudeRunnerEnv(parentEnv);
  }
  const runtimeRoot = join(input.cwd, ".autokit", "runner-home", input.phase);
  const home = join(runtimeRoot, "home");
  const xdgConfigHome = join(runtimeRoot, "xdg-config");
  const xdgCacheHome = join(runtimeRoot, "xdg-cache");
  const ghConfigDir = join(runtimeRoot, "gh");
  for (const path of [home, xdgConfigHome, xdgCacheHome, ghConfigDir]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return buildClaudeRunnerEnv(parentEnv, {
    home,
    xdgConfigHome,
    xdgCacheHome,
    ghConfigDir,
    gitConfigGlobal: "/dev/null",
    gitConfigNoSystem: "1",
  });
}

function buildClaudePathGuardCommand(workspaceRoot: string, hook: ClaudeHook): string {
  const script = `
const fs = require("node:fs");
const cp = require("node:child_process");
const path = require("node:path");
const root = ${JSON.stringify(workspaceRoot)};
const hook = ${JSON.stringify(hook)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input || "{}");
    const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
    const toolInput = event.tool_input && typeof event.tool_input === "object" && !Array.isArray(event.tool_input) ? event.tool_input : {};
    const result = validate(toolName, toolInput);
    if (!result.ok) {
      deny(result.reason);
      return;
    }
    if (result.updatedInput) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: result.updatedInput } }));
    }
  } catch {
    deny("invalid hook input");
  }
});
function validate(toolName, toolInput) {
  if (toolName === "Read" || toolName === "Grep" || toolName === "Glob") return validatePaths(toolName, toolInput, "read");
  if (toolName === "Edit" || toolName === "Write") {
    if (hook !== "write_path_guard") return { ok: false, reason: toolName + " is denied for read-only Claude phases" };
    return validatePaths(toolName, toolInput, "write");
  }
  if (toolName === "Bash") {
    if (hook !== "write_path_guard") return { ok: false, reason: "Bash is denied for read-only Claude phases" };
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    const guarded = validateCommand(command);
    if (!guarded.ok) return guarded;
    return { ok: true, updatedInput: { ...toolInput, command: buildRunnerCommand(command) } };
  }
  return { ok: true };
}
function validatePaths(toolName, toolInput, access) {
  const candidates = [];
  for (const key of ["file_path", "path"]) {
    const value = toolInput[key];
    if (typeof value === "string" && value.length > 0) candidates.push(value);
  }
  for (const candidate of candidates) {
    const decision = validatePath(candidate, access);
    if (!decision.ok) return decision;
  }
    const patterns = [];
    if (toolName === "Glob" && typeof toolInput.pattern === "string") patterns.push(toolInput.pattern);
    if (toolName === "Grep" && typeof toolInput.glob === "string") patterns.push(toolInput.glob);
	    for (const pattern of patterns) {
	      if (pattern.startsWith("/") || pattern.startsWith("~") || pattern.includes("../") || pattern === "..") {
	        return { ok: false, reason: "Tool pattern escapes workspace scope: " + pattern };
	      }
	      const decision = validatePath(pattern, "read");
	      if (!decision.ok) return decision;
	    }
	  return { ok: true };
	}
	function validatePath(candidate, access) {
	  if (candidate.startsWith("~") || candidate.includes("\\\\0")) return { ok: false, reason: "path escapes workspace scope" };
	  const rootReal = fs.realpathSync.native(root);
	  const resolved = path.resolve(rootReal, candidate);
	  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) return { ok: false, reason: "path escapes workspace scope" };
	  let real = resolved;
	  try { real = fs.realpathSync.native(resolved); } catch {
	    if (access === "write") {
	      let parent = path.dirname(resolved);
	      while (parent !== rootReal && parent.startsWith(rootReal + path.sep) && !fs.existsSync(parent)) parent = path.dirname(parent);
	      try { real = fs.realpathSync.native(parent); } catch {}
	      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return { ok: false, reason: "path escapes workspace scope" };
	    }
	  }
	  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return { ok: false, reason: "path escapes workspace scope" };
	  const relative = path.relative(rootReal, resolved).replaceAll(path.sep, "/");
	  const realRelative = path.relative(rootReal, real).replaceAll(path.sep, "/");
	  const secret = isSecret(relative) || isSecret(realRelative);
	  if (secret) return { ok: false, reason: "secret path denied" };
	  if (access === "write" && (relative.split("/").includes(".git") || realRelative.split("/").includes(".git"))) return { ok: false, reason: ".git state writes are denied" };
	  return { ok: true };
	}
	function isSecret(relative) {
	  const name = path.basename(relative);
	  const segments = relative.split("/");
	  return name.startsWith(".env") || segments.includes(".codex") || segments.includes(".claude") || name.startsWith("id_rsa") || name.endsWith(".pem") || name.endsWith(".key") || relative === ".autokit/audit-hmac-key";
	}
function validateCommand(command) {
  if (/[;&|<>\\x60$()\\n\\r]/.test(command)) return { ok: false, reason: "shell operators are denied" };
  const tokens = command.trim().split(/\\s+/).filter(Boolean);
  if (tokens.length === 0) return { ok: false, reason: "empty command denied" };
  const bin = path.basename(tokens[0]);
  const sub = tokens[1];
  const tail = tokens.slice(2).join(" ");
	  if (tail.includes(".env") || tail.includes(".codex") || tail.includes(".claude") || tail.includes("id_rsa") || tail.includes(".pem") || tail.includes(".key")) return { ok: false, reason: "secret path denied" };
	  if (bin === "git") {
	    if (!["status", "diff", "show", "log", "blame"].includes(sub)) return { ok: false, reason: "git " + sub + " is not allowed" };
	    const pathDecision = validateCommandPaths(tokens.slice(2), "read");
	    if (!pathDecision.ok) return pathDecision;
	    if (tokens.some((token) => token.includes(":.env") || token === ".env")) return { ok: false, reason: "secret path denied" };
	    return { ok: true };
	  }
  if (bin === "gh") {
	    if ((sub === "issue" || sub === "pr") && ["view", "list"].includes(tokens[2])) return { ok: true };
	    if (sub === "api") {
	      const methodIndex = tokens.findIndex((token) => token === "--method" || token === "-X");
	      const method = methodIndex >= 0 ? (tokens[methodIndex + 1] || "GET").toUpperCase() : (tokens.find((token) => token.startsWith("--method=")) || "--method=GET").slice("--method=".length).toUpperCase();
	      if (method !== "GET") return { ok: false, reason: "gh api " + method + " is not allowed" };
	      return validateCommandPaths(tokens.slice(2), "read");
	    }
	    return { ok: false, reason: "gh " + sub + " is not allowed" };
	  }
	  if (["bun", "npm", "pnpm", "yarn"].includes(bin)) {
	    const pathDecision = validateCommandPaths(tokens.slice(1), "read");
	    if (!pathDecision.ok) return pathDecision;
	    const script = tokens[1] === "run" ? tokens[2] : tokens[1];
    if (!/^(build|test|lint|format)(:[A-Za-z0-9_.-]+)?$/.test(script || "")) return { ok: false, reason: "package script is not in the guarded allowlist" };
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      const body = packageJson && packageJson.scripts && typeof packageJson.scripts[script] === "string" ? packageJson.scripts[script] : "";
      if (/\\.(env|codex|claude)(\\b|\\/)|(^|[\\s"'])\\.env(\\b|[.\\s"'])/.test(body)) return { ok: false, reason: "package script touches a secret path" };
      if (/(^|[\\s"'])(\\/[^^\\s"']+\\/)?git\\s+(add|branch|checkout|commit|merge|push|rebase|reset|restore|switch|tag|worktree)\\b/.test(body)) return { ok: false, reason: "package script bypasses guarded git policy" };
      if (/(^|[\\s"'])(\\/[^^\\s"']+\\/)?gh\\s+((pr|issue)\\s+(create|merge|close|comment|review|edit)|api\\s+(--method\\s+(?!GET\\b)|-X\\s+(?!GET\\b)|--method=(?!GET\\b)))/.test(body)) return { ok: false, reason: "package script bypasses guarded gh policy" };
    } catch {}
    return { ok: true };
  }
	  return { ok: false, reason: "command is not allowed: " + bin };
	}
	function validateCommandPaths(tokens, access) {
	  for (const token of tokens) {
	    if (token.length === 0 || token.startsWith("-")) continue;
	    const candidates = [token];
	    const colonIndex = token.indexOf(":");
	    if (colonIndex >= 0 && colonIndex < token.length - 1) candidates.push(token.slice(colonIndex + 1));
	    for (const candidate of candidates) {
	      if (looksPathSensitive(candidate)) {
	        const decision = validatePath(candidate, access);
	        if (!decision.ok) return decision;
	      }
	    }
	  }
	  return { ok: true };
	}
	function looksPathSensitive(value) {
	  return value.startsWith(".") || value.startsWith("/") || value.startsWith("~") || value.includes("/") || value.includes("\\\\") || value.includes(".env") || value.includes(".codex") || value.includes(".claude") || value.includes("id_rsa") || value.endsWith(".pem") || value.endsWith(".key");
	}
function buildRunnerCommand(command) {
  return ${JSON.stringify(buildGuardedCommandRunnerScriptCommandPrefix(workspaceRoot))} + Buffer.from(command, "utf8").toString("base64");
}
function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" }, systemMessage: "sandbox_violation: " + reason }));
}
`;
  return nodeEvalCommand(script);
}

function buildGuardedCommandRunnerCommand(workspaceRoot: string, command: string): string {
  return `${buildGuardedCommandRunnerScriptCommandPrefix(workspaceRoot)}${Buffer.from(command, "utf8").toString("base64")}`;
}

function buildGuardedCommandRunnerScriptCommandPrefix(workspaceRoot: string): string {
  const script = `
const cp = require("node:child_process");
const path = require("node:path");
	const command = Buffer.from(process.argv.at(-1) || "", "base64").toString("utf8");
	const root = ${JSON.stringify(workspaceRoot)};
	const rootAliases = [root, root.startsWith("/private/var/") ? root.replace(/^\\/private/, "") : ""].filter(Boolean);
	const extraRedactPatterns = ${JSON.stringify(DEFAULT_CONFIG.logging.redact_patterns)};
const tokens = command.trim().split(/\\s+/).filter(Boolean);
const runtimeRoot = path.join(root, ".autokit", "runner-home", "guarded-command");
const env = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: path.join(runtimeRoot, "home"), XDG_CONFIG_HOME: path.join(runtimeRoot, "xdg-config"), XDG_CACHE_HOME: path.join(runtimeRoot, "xdg-cache"), GH_CONFIG_DIR: path.join(runtimeRoot, "gh"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANG: process.env.LANG || "C.UTF-8", TERM: process.env.TERM || "dumb" };
for (const dir of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.GH_CONFIG_DIR]) require("node:fs").mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = cp.spawnSync(tokens[0], tokens.slice(1), { cwd: root, env, encoding: "utf8" });
process.stdout.write(sanitize(result.stdout || ""));
process.stderr.write(sanitize(result.stderr || ""));
process.exit(typeof result.status === "number" ? result.status : 1);
function sanitize(value) {
  let sanitized = String(value)
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "<REDACTED>")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "<REDACTED>")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "<REDACTED>")
    .replace(/Bearer\\s+[^\\s]+/gi, "Bearer <REDACTED>")
    .replace(/Authorization:\\s*\\S+(?:\\s+\\S+)?/gi, "Authorization: <REDACTED>")
    .replace(/"private_key"\\s*:\\s*"[^"]+"/g, "\\"private_key\\":\\"<REDACTED>\\"")
    .replace(/(refreshToken|oauthAccessToken|access_token|refresh_token|id_token|token)["']?\\s*[:=]\\s*["'][^"']+["']/gi, "$1=<REDACTED>")
    .replace(/ssh-rsa\\s+[A-Za-z0-9+/=]+/g, "<REDACTED>")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<REDACTED>")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "<REDACTED>")
    .replace(/aws_access_key_id\\s*=\\s*\\S+/gi, "aws_access_key_id=<REDACTED>")
    .replace(/aws_secret_access_key\\s*=\\s*\\S+/gi, "aws_secret_access_key=<REDACTED>")
    .replace(/(aws[_-]?(secret|access)[_-]?key)["']?\\s*[:=]\\s*["']?[^"'\\s]+["']?/gi, "$1=<REDACTED>")
    .replace(/((?:^|[\\s"'(])\\.env[^\\s:=]*:?\\d*\\s+[A-Za-z_][A-Za-z0-9_]*=)([^\\s"'()]+)/g, "$1<REDACTED>")
    .replace(/\\/Users\\/[^\\/\\s]+/g, "~");
  for (const alias of rootAliases) sanitized = sanitized.replaceAll(alias, "<repo>");
  for (const pattern of extraRedactPatterns) sanitized = sanitized.replace(new RegExp(pattern, "g"), "<REDACTED>");
  return sanitized;
}
	`;
  return `${nodeEvalCommand(script)} -- `;
}

function nodeEvalCommand(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const loader = `eval(Buffer.from(${JSON.stringify(encoded)},"base64").toString("utf8"))`;
  return `node -e ${JSON.stringify(loader)}`;
}

function readPackageScripts(workspaceRoot: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.scripts).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
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
  const sanitized = sanitizeLogString(message, DEFAULT_CONFIG, false, {
    homeDir: process.env.HOME,
  }).replace(/\/Users\/[^/\s]+/g, "~");
  return truncateMessage(sanitized);
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
