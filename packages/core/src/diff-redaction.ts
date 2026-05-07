import type { AutokitConfig } from "./config.js";
import type { RedactionPathContext } from "./redaction.js";
import { sanitizeLogString } from "./redaction.js";

export function redactGitDiff(
  rawDiff: string,
  config: AutokitConfig,
  paths: RedactionPathContext = {},
): string {
  if (rawDiff.length === 0) {
    return "";
  }
  const sections = splitDiffSections(rawDiff);
  const redacted = sections.map((section) => redactDiffSection(section, config, paths));
  return ensureTrailingNewline(redacted.join(""));
}

function splitDiffSections(rawDiff: string): string[] {
  const lines = rawDiff.split(/\n/);
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(`${current.join("\n")}\n`);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    sections.push(current.join("\n"));
  }
  return sections;
}

function redactDiffSection(
  section: string,
  config: AutokitConfig,
  paths: RedactionPathContext,
): string {
  const sectionPaths = extractDiffPaths(section);
  const blacklistedPath = sectionPaths.find(isBlacklistedDiffPath);
  if (blacklistedPath !== undefined) {
    return `[REDACTED hunk: ${sanitizeLogString(blacklistedPath, config, false, paths)}]\n`;
  }
  return sanitizeLogString(section, config, false, paths);
}

function extractDiffPaths(section: string): string[] {
  const paths: string[] = [];
  const nextFile = section.match(/^\+\+\+ (?:b\/)?(.+)$/m);
  if (nextFile !== null) {
    const path = normalizeGitPath(nextFile[1]);
    if (path !== "/dev/null") {
      paths.push(path);
    }
  }
  const previousFile = section.match(/^--- (?:a\/)?(.+)$/m);
  if (previousFile !== null) {
    const path = normalizeGitPath(previousFile[1]);
    if (path !== "/dev/null") {
      paths.push(path);
    }
  }
  const diffHeader = section.match(/^diff --git (?:a\/)?(.+?) (?:b\/)?(.+)$/m);
  if (diffHeader !== null) {
    const next = normalizeGitPath(diffHeader[2] ?? diffHeader[1] ?? "");
    if (next !== "/dev/null") {
      paths.push(next);
    }
    const previous = normalizeGitPath(diffHeader[1] ?? "");
    if (previous !== "" && previous !== "/dev/null") {
      paths.push(previous);
    }
  }
  for (const pattern of [
    /^rename from (.+)$/m,
    /^rename to (.+)$/m,
    /^copy from (.+)$/m,
    /^copy to (.+)$/m,
  ]) {
    const match = section.match(pattern);
    if (match?.[1] !== undefined) {
      paths.push(normalizeGitPath(match[1]));
    }
  }
  return [...new Set(paths.filter((path) => path.length > 0))];
}

function normalizeGitPath(path: string): string {
  return (
    path
      .split("\t")[0]
      ?.replace(/^"(.+)"$/, "$1")
      .replace(/\\/g, "/") ?? ""
  );
}

function isBlacklistedDiffPath(path: string): boolean {
  const normalized = path.replace(/^\.?\//, "");
  return normalized
    .split("/")
    .some((part, index, parts) => isBlacklistedPathPart(part, index, parts));
}

function isBlacklistedPathPart(part: string, index: number, parts: string[]): boolean {
  const normalized = part.toLowerCase();
  const next = parts[index + 1]?.toLowerCase() ?? "";
  if (normalized.startsWith(".env")) {
    return true;
  }
  if (normalized === ".codex") {
    return true;
  }
  if (normalized === ".autokit" && next === "audit-hmac-key") {
    return true;
  }
  if (normalized === ".claude" && next.startsWith("credentials")) {
    return true;
  }
  if (normalized.startsWith("id_rsa")) {
    return true;
  }
  return /\.(?:pem|key)$/i.test(normalized);
}

function ensureTrailingNewline(value: string): string {
  return value.length === 0 || value.endsWith("\n") ? value : `${value}\n`;
}
