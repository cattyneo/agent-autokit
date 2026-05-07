import { createHmac } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import pino from "pino";

import type { AutokitConfig } from "./config.ts";
import { type FailureCode, failureCodes } from "./failure-codes.ts";
import { sanitizeLogString } from "./redaction.ts";

export type { FailureCode };
export { failureCodes };

export const failureAuditKinds = failureCodes;

export const operationalAuditKinds = [
  "resume",
  "resumed",
  "lock_seized",
  "init_rollback",
  "init_rollback_failed",
  "retry_resumed",
  "runner_idle",
  "audit_hmac_key_rotated",
  "queue_corruption_recovered",
  "sanitize_pass_hmac",
  "auto_merge_disabled",
  "auto_merge_reserved",
  "branch_deleted",
  "retry_pr_closed",
  "effort_downgrade",
  "phase_self_correct",
  "phase_started",
  "phase_completed",
  "review_finding_seen",
  "fix_started",
  "fix_finished",
  "review_started",
  "phase_override_started",
  "phase_override_ended",
  "serve_lock_busy",
  "sse_write_failed",
] as const;

export type FailureAuditKind = (typeof failureAuditKinds)[number];
export type OperationalAuditKind = (typeof operationalAuditKinds)[number];
export type AuditKind = FailureAuditKind | OperationalAuditKind;
export type LogLevel = "debug" | "info" | "warn" | "error";

export type FailureRecord = {
  phase: string;
  code: FailureCode;
  message: string;
  ts: string;
};

export type SanitizeViolationAuditPayload = {
  pattern: string;
  before_hmac: string;
  after_hmac: string;
  byte_length: number;
};

export type LoggerHooks = {
  renameSync?: (oldPath: string, newPath: string) => void;
};

export type CreateAutokitLoggerOptions = {
  logDir: string;
  config: AutokitConfig;
  level?: LogLevel;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  now?: () => Date;
  hooks?: LoggerHooks;
};

export type AuditFailureInput = {
  failure: FailureRecord;
  issue?: number;
  payload?: Record<string, unknown>;
};

export type StateAuditInput = {
  kind: OperationalAuditKind;
  fields?: Record<string, unknown>;
};

export class AutokitLogger {
  private readonly writer: AtomicJsonlWriter;
  private readonly pinoLogger: pino.Logger;
  private readonly config: AutokitConfig;

  constructor(options: CreateAutokitLoggerOptions) {
    this.config = options.config;
    this.writer = new AtomicJsonlWriter(options);
    this.pinoLogger = pino(
      {
        base: undefined,
        level: options.level ?? options.config.logging.level,
        messageKey: "msg",
        timestamp: false,
        formatters: {
          level(label) {
            return { level: label };
          },
        },
      },
      this.writer,
    );
  }

  debug(fields: Record<string, unknown>, message: string): void {
    this.log("debug", fields, message);
  }

  info(fields: Record<string, unknown>, message: string): void {
    this.log("info", fields, message);
  }

  warn(fields: Record<string, unknown>, message: string): void {
    this.log("warn", fields, message);
  }

  error(fields: Record<string, unknown>, message: string): void {
    this.log("error", fields, message);
  }

  auditFailure(input: AuditFailureInput): void {
    if (!isFailureCode(input.failure.code)) {
      throw new Error(`Unknown failure audit kind: ${input.failure.code}`);
    }

    this.info(
      {
        issue: input.issue,
        event: "audit",
        kind: input.failure.code,
        failure: input.failure,
        payload: input.payload,
      },
      input.failure.message,
    );
  }

  auditOperation(kind: OperationalAuditKind, fields: Record<string, unknown> = {}): void {
    const level: LogLevel = kind === "runner_idle" ? "warn" : "info";
    this.log(level, { ...fields, event: "audit", kind }, String(kind));
  }

  writeStateAndAudit(commit: () => void, audit: StateAuditInput): void {
    commit();
    this.auditOperation(audit.kind, audit.fields);
  }

  close(): void {
    this.writer.close();
  }

  private log(level: LogLevel, fields: Record<string, unknown>, message: string): void {
    const sanitizedFields = sanitizeLogValue(fields, this.config, level === "debug") as Record<
      string,
      unknown
    >;
    const sanitizedMessage = sanitizeLogString(message, this.config, level === "debug");
    this.pinoLogger[level](sanitizedFields, sanitizedMessage);
  }
}

export function createAutokitLogger(options: CreateAutokitLoggerOptions): AutokitLogger {
  return new AutokitLogger(options);
}

export function createSanitizeViolationAuditPayload(input: {
  beforeText: string;
  afterText: string;
  hmacKey: string | Buffer;
  pattern: string;
}): SanitizeViolationAuditPayload {
  return {
    pattern: input.pattern,
    before_hmac: createHmac("sha256", input.hmacKey).update(input.beforeText).digest("hex"),
    after_hmac: createHmac("sha256", input.hmacKey).update(input.afterText).digest("hex"),
    byte_length: Buffer.byteLength(input.beforeText),
  };
}

class AtomicJsonlWriter {
  private readonly logDir: string;
  private readonly now: () => Date;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly retentionDays: number;
  private readonly hooks: Required<LoggerHooks>;
  private fd: number | null = null;
  private currentPath = "";
  private currentDate = "";
  private currentSize = 0;

  constructor(options: CreateAutokitLoggerOptions) {
    this.logDir = options.logDir;
    this.now = options.now ?? (() => new Date());
    this.maxFileBytes = options.maxFileBytes ?? options.config.logging.max_file_size_mb * 1024 ** 2;
    this.maxTotalBytes =
      options.maxTotalBytes ?? options.config.logging.max_total_size_mb * 1024 ** 2;
    this.retentionDays = options.config.logging.retention_days;
    this.hooks = {
      renameSync: options.hooks?.renameSync ?? renameSync,
    };

    mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    this.openForDate(formatTokyoDate(this.now()), false);
    this.sweepOversizedCurrentLog();
    this.sweepOldLogs();
  }

  write(chunk: string | Uint8Array): void {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (text.length === 0) {
      return;
    }

    this.ensureCurrentDate();
    const bytes = Buffer.byteLength(text);
    if (this.currentSize > 0 && this.currentSize + bytes > this.maxFileBytes) {
      this.rotateCurrentLog();
    }

    this.writeRaw(text);
  }

  close(): void {
    if (this.fd === null) {
      return;
    }
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.fd = null;
  }

  private ensureCurrentDate(): void {
    const date = formatTokyoDate(this.now());
    if (date !== this.currentDate) {
      this.close();
      this.openForDate(date, false);
      this.sweepOldLogs();
    }
  }

  private openForDate(date: string, exclusive: boolean): void {
    this.currentDate = date;
    this.currentPath = join(this.logDir, `${date}.log`);
    const flags = exclusive ? "ax" : "a";
    this.fd = openSync(this.currentPath, flags, 0o600);
    fchmodSync(this.fd, 0o600);
    this.currentSize = statSync(this.currentPath).size;
  }

  private sweepOversizedCurrentLog(): void {
    if (this.currentSize > this.maxFileBytes) {
      this.rotateCurrentLog();
    }
  }

  private rotateCurrentLog(): void {
    if (this.fd === null) {
      this.openForDate(this.currentDate, false);
    }

    const fd = this.fd;
    if (fd === null) {
      throw new Error("log fd is not open");
    }

    fsyncSync(fd);
    const rotatedPath = this.nextRotatedPath();
    try {
      this.hooks.renameSync(this.currentPath, rotatedPath);
      closeSync(fd);
      this.fd = null;
      this.openForDate(this.currentDate, true);
      this.sweepOldLogs();
    } catch (error) {
      this.writeRaw(
        `${JSON.stringify({
          ts: formatTokyoTimestamp(this.now()),
          level: "warn",
          event: "log_rotate_failed",
          msg: "log rotation failed; continuing with current file",
          error: sanitizeErrorMessage(error),
        })}\n`,
      );
    }
  }

  private nextRotatedPath(): string {
    let index = 1;
    while (true) {
      const path = join(this.logDir, `${this.currentDate}-${index}.log`);
      if (!existsSync(path)) {
        return path;
      }
      index += 1;
    }
  }

  private sweepOldLogs(): void {
    const entries = listLogFiles(this.logDir);
    const now = this.now().getTime();
    const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (entry.path === this.currentPath) {
        continue;
      }
      if (now - entry.mtimeMs > retentionMs) {
        unlinkSync(entry.path);
      }
    }

    let remaining = listLogFiles(this.logDir);
    let totalBytes = remaining.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of remaining.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (totalBytes <= this.maxTotalBytes) {
        break;
      }
      if (entry.path === this.currentPath) {
        continue;
      }
      unlinkSync(entry.path);
      totalBytes -= entry.size;
    }

    remaining = listLogFiles(this.logDir);
    const current = remaining.find((entry) => entry.path === this.currentPath);
    if (current !== undefined) {
      this.currentSize = current.size;
    }
  }

  private writeRaw(text: string): void {
    if (this.fd === null) {
      this.openForDate(this.currentDate || formatTokyoDate(this.now()), false);
    }
    const fd = this.fd;
    if (fd === null) {
      throw new Error("log fd is not open");
    }
    const bytes = writeSync(fd, text);
    this.currentSize += bytes;
  }
}

function listLogFiles(logDir: string): Array<{ path: string; size: number; mtimeMs: number }> {
  return readdirSync(logDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}(?:-\d+)?\.log$/.test(name))
    .map((name) => {
      const path = join(logDir, name);
      const stat = statSync(path);
      return { path, size: stat.size, mtimeMs: stat.mtimeMs };
    });
}

function sanitizeLogValue(value: unknown, config: AutokitConfig, debug: boolean): unknown {
  if (typeof value === "string") {
    return sanitizeLogString(value, config, debug);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, config, debug));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeLogValue(item, config, debug)]),
    );
  }
  return value;
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isFailureCode(code: string): code is FailureCode {
  return (failureCodes as readonly string[]).includes(code);
}

function formatTokyoDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatTokyoTimestamp(date: Date): string {
  const tokyoEpoch = date.getTime() + 9 * 60 * 60 * 1000;
  return `${new Date(tokyoEpoch).toISOString().replace(/\.\d{3}Z$/, "")}+09:00`;
}
