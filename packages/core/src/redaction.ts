import type { AutokitConfig } from "./config.js";

export type RedactionPathContext = {
  homeDir?: string;
  repoRoot?: string;
};

export function sanitizeLogString(
  value: string,
  config: AutokitConfig,
  debug = false,
  paths: RedactionPathContext = {},
): string {
  let sanitized = redactEnvLineValues(value);
  sanitized = redactKnownPaths(sanitized, paths);
  for (const pattern of builtInRedactPatterns(config)) {
    sanitized = sanitized.replace(pattern, "<REDACTED>");
  }
  return debug ? truncateDebugString(sanitized) : sanitized;
}

function redactKnownPaths(value: string, paths: RedactionPathContext): string {
  let sanitized = value;
  if (paths.homeDir !== undefined && paths.homeDir.length > 1) {
    sanitized = sanitized.replace(pathPattern(paths.homeDir), "~");
  }
  if (paths.repoRoot !== undefined && paths.repoRoot.length > 1) {
    sanitized = sanitized.replace(pathPattern(paths.repoRoot), "<repo>");
  }
  return sanitized;
}

function pathPattern(path: string): RegExp {
  return new RegExp(escapeRegExp(path.replace(/\/$/, "")), "g");
}

function redactEnvLineValues(value: string): string {
  return value.replace(
    /((?:^|[\s(:,/])\.env(?:\.[\w.-]+)?:\d+\s+[A-Za-z_][A-Za-z0-9_]*=)[^\s),]+/g,
    "$1<REDACTED>",
  );
}

function builtInRedactPatterns(config: AutokitConfig): RegExp[] {
  return [
    /ghp_[A-Za-z0-9]{20,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /sk-[A-Za-z0-9]{20,}/g,
    /Bearer\s+[A-Za-z0-9._:-]+/gi,
    /Authorization:\s*Bearer\s+[A-Za-z0-9._:-]+/gi,
    /ssh-rsa\s+[A-Za-z0-9+/=]+/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /xox[baprs]-[A-Za-z0-9-]+/g,
    /aws_access_key_id\s*=\s*\S+/gi,
    /aws_secret_access_key\s*=\s*\S+/gi,
    ...config.logging.redact_patterns.map((pattern) => new RegExp(pattern, "g")),
  ];
}

function truncateDebugString(value: string): string {
  if (value.length <= 200) {
    return value;
  }
  return `${value.slice(0, 200)}...truncated ${value.length - 200} chars`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
