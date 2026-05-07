import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { DEFAULT_CONFIG } from "./config.js";
import type { RedactionPathContext } from "./redaction.js";
import { sanitizeLogString } from "./redaction.js";

export type PathAccess = "read" | "write";
export type PathSafetyDecision = { ok: true } | { ok: false; reason: string };
export type GuardedCommandDecision =
  | { ok: true; kind: "git" | "gh" | "package_script"; tokens: string[] }
  | { ok: false; reason: string };

const allowedGitSubcommands = new Set(["status", "diff", "show", "log", "blame"]);
const deniedGitSubcommands = new Set([
  "add",
  "branch",
  "checkout",
  "commit",
  "merge",
  "push",
  "rebase",
  "reset",
  "restore",
  "switch",
  "tag",
  "worktree",
]);
const packageManagers = new Set(["bun", "npm", "pnpm", "yarn"]);
const allowedPackageScripts = /^(?:build|test|lint|format)(?::[A-Za-z0-9_.-]+)?$/;

export function validatePathAccess(input: {
  workspaceRoot: string;
  candidate: string;
  access: PathAccess;
}): PathSafetyDecision {
  const candidate = input.candidate.trim();
  if (candidate.length === 0) {
    return { ok: true };
  }
  if (candidate.startsWith("~")) {
    return { ok: false, reason: "path escapes workspace scope" };
  }

  const lexicalRoot = normalizePath(resolve(input.workspaceRoot));
  const normalizedRoot = safeRealpath(lexicalRoot) ?? lexicalRoot;
  const resolved = resolveCandidate(lexicalRoot, candidate);
  if (resolved === null || !isInside(lexicalRoot, resolved)) {
    return { ok: false, reason: "path escapes workspace scope" };
  }
  const realDecision = validateRealPathScope({
    lexicalRoot,
    normalizedRoot,
    resolved,
    access: input.access,
  });
  if (!realDecision.ok) {
    return realDecision;
  }

  const relativePath = normalizePath(relative(lexicalRoot, resolved));
  const realRelativePath =
    realDecision.realPath === undefined
      ? relativePath
      : normalizePath(relative(normalizedRoot, realDecision.realPath));
  if (isSecretPath(relativePath) || isSecretPath(realRelativePath)) {
    return {
      ok: false,
      reason: `secret or credential path denied: ${categoryForPath(realRelativePath)}`,
    };
  }
  if (
    input.access === "write" &&
    (hasSegment(relativePath, ".git") || hasSegment(realRelativePath, ".git"))
  ) {
    return { ok: false, reason: ".git state writes are denied" };
  }
  return { ok: true };
}

export function validateGuardedCommand(input: {
  workspaceRoot: string;
  command: string;
  packageScripts?: Record<string, string>;
}): GuardedCommandDecision {
  const parsed = tokenizeSimpleCommand(input.command);
  if (!parsed.ok) {
    return parsed;
  }
  const tokens = parsed.tokens;
  if (tokens.length === 0) {
    return { ok: false, reason: "empty command denied" };
  }

  const binary = basename(tokens[0]);
  if (binary === "git") {
    return validateGitCommand(input.workspaceRoot, tokens);
  }
  if (binary === "gh") {
    return validateGhCommand(input.workspaceRoot, tokens);
  }
  if (packageManagers.has(binary)) {
    return validatePackageScriptCommand(input.workspaceRoot, tokens, input.packageScripts ?? {});
  }
  return { ok: false, reason: `command is not allowed: ${binary}` };
}

export function sanitizeCommandOutput(output: string, paths: RedactionPathContext = {}): string {
  return sanitizeLogString(output, DEFAULT_CONFIG, false, paths);
}

function validateGitCommand(workspaceRoot: string, tokens: string[]): GuardedCommandDecision {
  const subcommand = tokens[1];
  if (subcommand === undefined) {
    return { ok: false, reason: "git subcommand is required" };
  }
  if (deniedGitSubcommands.has(subcommand) || !allowedGitSubcommands.has(subcommand)) {
    return { ok: false, reason: `git ${subcommand} is not allowed` };
  }
  const pathDecision = validateCommandPathTokens(workspaceRoot, tokens.slice(2), "read");
  if (!pathDecision.ok) {
    return pathDecision;
  }
  return { ok: true, kind: "git", tokens };
}

function validateGhCommand(workspaceRoot: string, tokens: string[]): GuardedCommandDecision {
  const resource = tokens[1];
  const action = tokens[2];
  if ((resource === "issue" || resource === "pr") && (action === "view" || action === "list")) {
    const pathDecision = validateCommandPathTokens(workspaceRoot, tokens.slice(3), "read");
    return pathDecision.ok ? { ok: true, kind: "gh", tokens } : pathDecision;
  }
  if (resource === "api") {
    const method = ghApiMethod(tokens);
    if (method !== "GET") {
      return { ok: false, reason: `gh api ${method} is not allowed` };
    }
    const pathDecision = validateCommandPathTokens(workspaceRoot, tokens.slice(2), "read");
    return pathDecision.ok ? { ok: true, kind: "gh", tokens } : pathDecision;
  }
  return { ok: false, reason: `gh ${resource ?? ""} ${action ?? ""} is not allowed`.trim() };
}

function validatePackageScriptCommand(
  workspaceRoot: string,
  tokens: string[],
  packageScripts: Record<string, string>,
): GuardedCommandDecision {
  const pathDecision = validateCommandPathTokens(workspaceRoot, tokens.slice(1), "read");
  if (!pathDecision.ok) {
    return pathDecision;
  }
  const binary = basename(tokens[0]);
  const script = packageScriptName(binary, tokens);
  if (script === null || !allowedPackageScripts.test(script)) {
    return { ok: false, reason: "package script is not in the guarded allowlist" };
  }
  const scriptBody = packageScripts[script];
  if (scriptBody !== undefined) {
    const bodyDecision = validatePackageScriptBody(scriptBody);
    if (!bodyDecision.ok) {
      return bodyDecision;
    }
  }
  return { ok: true, kind: "package_script", tokens };
}

function validatePackageScriptBody(scriptBody: string): PathSafetyDecision {
  if (/\.(?:env|codex|claude)(?:\b|\/)|(?:^|[\s"'])\.env(?:\b|[.\s"'])/.test(scriptBody)) {
    return { ok: false, reason: "package script touches a secret path" };
  }
  if (
    /(?:^|[\s"'])(?:\/[^\s"']+\/)?git\s+(?:add|branch|checkout|commit|merge|push|rebase|reset|restore|switch|tag|worktree)\b/.test(
      scriptBody,
    )
  ) {
    return { ok: false, reason: "package script bypasses guarded git policy" };
  }
  if (
    /(?:^|[\s"'])(?:\/[^\s"']+\/)?gh\s+(?:(?:pr|issue)\s+(?:create|merge|close|comment|review|edit)|api\s+(?:--method\s+(?!GET\b)|-X\s+(?!GET\b)|--method=(?!GET\b)))/.test(
      scriptBody,
    )
  ) {
    return { ok: false, reason: "package script bypasses guarded gh policy" };
  }
  return { ok: true };
}

function validateCommandPathTokens(
  workspaceRoot: string,
  tokens: string[],
  access: PathAccess,
): PathSafetyDecision {
  for (const token of tokens) {
    for (const candidate of pathCandidatesFromToken(token)) {
      const decision = validatePathAccess({ workspaceRoot, candidate, access });
      if (!decision.ok) {
        return decision;
      }
    }
  }
  return { ok: true };
}

function packageScriptName(binary: string, tokens: string[]): string | null {
  if (binary === "npm" || binary === "pnpm" || binary === "yarn") {
    if (tokens[1] === "run") {
      return tokens[2] ?? null;
    }
    return tokens[1] ?? null;
  }
  if (binary === "bun") {
    if (tokens[1] === "run") {
      return tokens[2] ?? null;
    }
    return tokens[1] ?? null;
  }
  return null;
}

function ghApiMethod(tokens: string[]): string {
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--method" || token === "-X") {
      return (tokens[index + 1] ?? "GET").toUpperCase();
    }
    if (token.startsWith("--method=")) {
      return token.slice("--method=".length).toUpperCase();
    }
  }
  return "GET";
}

function pathCandidatesFromToken(token: string): string[] {
  if (token.length === 0 || token.startsWith("-")) {
    return [];
  }
  const candidates = [token];
  const colonIndex = token.indexOf(":");
  if (colonIndex >= 0 && colonIndex < token.length - 1) {
    candidates.push(token.slice(colonIndex + 1));
  }
  return candidates.filter(looksPathSensitive);
}

function looksPathSensitive(value: string): boolean {
  return (
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes(".env") ||
    value.includes(".codex") ||
    value.includes(".claude") ||
    value.includes("id_rsa") ||
    value.endsWith(".pem") ||
    value.endsWith(".key")
  );
}

function tokenizeSimpleCommand(
  command: string,
): { ok: true; tokens: string[] } | { ok: false; reason: string } {
  if (/[;&|<>`$()\n\r]/.test(command)) {
    return { ok: false, reason: "shell operators are denied" };
  }
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote !== null) {
    return { ok: false, reason: "unterminated quote denied" };
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return { ok: true, tokens };
}

function resolveCandidate(workspaceRoot: string, candidate: string): string | null {
  if (candidate.includes("\0")) {
    return null;
  }
  const normalizedCandidate = candidate.replaceAll("\\", "/");
  return normalizePath(
    isAbsolute(normalizedCandidate)
      ? normalizedCandidate
      : resolve(workspaceRoot, normalizedCandidate),
  );
}

function validateRealPathScope(input: {
  lexicalRoot: string;
  normalizedRoot: string;
  resolved: string;
  access: PathAccess;
}): PathSafetyDecision & { realPath?: string } {
  const targetRealPath = safeRealpath(input.resolved);
  if (targetRealPath !== undefined) {
    return isInside(input.normalizedRoot, targetRealPath)
      ? { ok: true, realPath: targetRealPath }
      : { ok: false, reason: "path escapes workspace scope" };
  }

  if (input.access === "read") {
    return { ok: true };
  }

  const parent = nearestExistingParent(input.lexicalRoot, input.resolved);
  const parentRealPath = parent === undefined ? undefined : safeRealpath(parent);
  if (parentRealPath !== undefined && !isInside(input.normalizedRoot, parentRealPath)) {
    return { ok: false, reason: "path escapes workspace scope" };
  }
  return { ok: true };
}

function nearestExistingParent(root: string, target: string): string | undefined {
  let current = dirname(target);
  while (isInside(root, current)) {
    if (existsSync(current)) {
      return current;
    }
    const next = dirname(current);
    if (next === current) {
      return undefined;
    }
    current = next;
  }
  return existsSync(root) ? root : undefined;
}

function isSecretPath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  const name = basename(normalized);
  return (
    name.startsWith(".env") ||
    hasSegment(normalized, ".codex") ||
    hasSegment(normalized, ".claude") ||
    name.startsWith("id_rsa") ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    normalized === ".autokit/audit-hmac-key"
  );
}

function categoryForPath(relativePath: string): string {
  const name = basename(relativePath);
  if (name.startsWith(".env")) {
    return "env";
  }
  if (relativePath.includes(".codex") || relativePath.includes(".claude")) {
    return "credential";
  }
  return "key";
}

function hasSegment(path: string, segment: string): boolean {
  return normalizePath(path).split("/").includes(segment);
}

function normalizePath(path: string): string {
  return path.replaceAll(sep, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function safeRealpath(path: string): string | undefined {
  try {
    return normalizePath(realpathSync.native(path));
  } catch {
    return undefined;
  }
}
