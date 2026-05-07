import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG, parseConfig } from "./config.ts";
import {
  createAutokitLogger,
  createSanitizeViolationAuditPayload,
  failureAuditKinds,
  failureCodes,
  operationalAuditKinds,
} from "./logger.ts";

describe("core logger audit tables", () => {
  it("keeps exported failure and operational audit kind sets aligned with SPEC", () => {
    const spec = readFileSync(new URL("../../../docs/SPEC.md", import.meta.url), "utf8");

    assert.deepEqual([...failureCodes].sort(), extractSpecFailureCodes(spec));
    assert.deepEqual([...failureAuditKinds].sort(), extractSpecFailureAuditKinds(spec));
    assert.deepEqual([...operationalAuditKinds].sort(), extractSpecOperationalAuditKinds(spec));
    assert.deepEqual([...failureAuditKinds], [...failureCodes]);
    assert.equal(operationalAuditKinds.length, 25);
  });
});

describe("core logger JSONL writer", () => {
  it("writes pino JSON lines with 0600 mode and sanitizes before debug truncation", () => {
    const root = makeTempDir();
    const logger = createAutokitLogger({
      logDir: root,
      config: parseConfig({
        logging: {
          level: "debug",
          redact_patterns: ["custom-secret-[0-9]+"],
        },
      }),
      now: () => new Date("2026-05-04T00:30:00.000Z"),
    });

    logger.debug(
      {
        issue: 7,
        runtime_phase: "review",
        detail: `custom-secret-123 ${"x".repeat(260)} ghp_${"a".repeat(24)}`,
        envLine: ".env:3 SECRET=super-secret-value",
      },
      `Bearer ghp_${"b".repeat(24)}`,
    );
    logger.info(
      {
        issue: 7,
        envLine: "path:(.env.local:4 TOKEN=another-secret)",
      },
      "env boundary",
    );
    logger.close();

    const logPath = join(root, "2026-05-04.log");
    const lines = readLogLines(logPath);
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].level, "debug");
    assert.equal(lines[0].msg.includes("ghp_"), false);
    assert.equal(lines[0].detail.includes("custom-secret-123"), false);
    assert.equal(lines[0].detail.includes("ghp_"), false);
    assert.equal(lines[0].detail.includes("...truncated"), true);
    assert.equal(lines[0].envLine, ".env:3 SECRET=<REDACTED>");
    assert.equal(lines[1].envLine, "path:(.env.local:4 TOKEN=<REDACTED>)");
  });

  it("writes failure audit events with sanitized failure fields and HMAC-only sanitize payloads", () => {
    const root = makeTempDir();
    const payload = createSanitizeViolationAuditPayload({
      beforeText: `raw ghp_${"c".repeat(24)}`,
      afterText: "<REDACTED>",
      hmacKey: "test-key",
      pattern: "ghp_token",
    });
    const logger = createAutokitLogger({
      logDir: root,
      config: DEFAULT_CONFIG,
      now: () => new Date("2026-05-04T00:31:00.000Z"),
    });

    logger.auditFailure({
      failure: {
        phase: "review",
        code: "sanitize_violation",
        message: `blocked ghp_${"d".repeat(24)}`,
        ts: "2026-05-04T09:31:00+09:00",
      },
      issue: 7,
      payload,
    });
    logger.close();

    const [line] = readLogLines(join(root, "2026-05-04.log"));
    assert.equal(line.event, "audit");
    assert.equal(line.kind, "sanitize_violation");
    assert.equal(line.level, "info");
    assert.equal(line.failure.code, "sanitize_violation");
    assert.equal(line.failure.message.includes("ghp_"), false);
    assert.match(line.payload.before_hmac, /^[a-f0-9]{64}$/);
    assert.match(line.payload.after_hmac, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(line).includes("raw ghp_"), false);
  });

  it("records operational audit events and uses warn for runner_idle", () => {
    const root = makeTempDir();
    const logger = createAutokitLogger({
      logDir: root,
      config: DEFAULT_CONFIG,
      now: () => new Date("2026-05-04T00:32:00.000Z"),
    });

    logger.auditOperation("runner_idle", { issue: 7, runtime_phase: "implement" });
    logger.auditOperation("resume", { issue: 7 });
    logger.close();

    const lines = readLogLines(join(root, "2026-05-04.log"));
    assert.equal(lines[0].kind, "runner_idle");
    assert.equal(lines[0].level, "warn");
    assert.equal(lines[1].kind, "resume");
    assert.equal(lines[1].level, "info");
  });

  it("rotates by size without dropping the event that triggered rotation", () => {
    const root = makeTempDir();
    const logger = createAutokitLogger({
      logDir: root,
      config: DEFAULT_CONFIG,
      maxFileBytes: 180,
      now: () => new Date("2026-05-04T00:33:00.000Z"),
    });

    logger.info({ issue: 7, payload: "a".repeat(120) }, "first");
    logger.info({ issue: 7, payload: "b".repeat(120) }, "second");
    logger.close();

    assert.equal(readLogLines(join(root, "2026-05-04-1.log"))[0].msg, "first");
    assert.equal(readLogLines(join(root, "2026-05-04.log"))[0].msg, "second");
  });

  it("keeps writing on rename failure and records a WARN line", () => {
    const root = makeTempDir();
    const logger = createAutokitLogger({
      logDir: root,
      config: DEFAULT_CONFIG,
      maxFileBytes: 180,
      now: () => new Date("2026-05-04T00:34:00.000Z"),
      hooks: {
        renameSync: () => {
          throw new Error("rename denied");
        },
      },
    });

    logger.info({ issue: 7, payload: "a".repeat(120) }, "first");
    logger.info({ issue: 7, payload: "b".repeat(120) }, "second");
    logger.close();

    const lines = readLogLines(join(root, "2026-05-04.log"));
    assert.equal(lines[0].msg, "first");
    assert.equal(lines[1].event, "log_rotate_failed");
    assert.equal(lines[1].level, "warn");
    assert.equal(lines[2].msg, "second");
  });

  it("sweeps old logs without deleting the current active log", () => {
    const root = makeTempDir();
    const oldLog = join(root, "2026-05-03.log");
    writeFileSync(oldLog, `${JSON.stringify({ level: "info", msg: "old" })}\n`, {
      mode: 0o600,
    });
    utimesSync(oldLog, new Date("2026-05-03T00:00:00.000Z"), new Date("2026-05-03T00:00:00.000Z"));

    const logger = createAutokitLogger({
      logDir: root,
      config: DEFAULT_CONFIG,
      maxTotalBytes: 1,
      now: () => new Date("2026-05-04T00:34:30.000Z"),
    });

    logger.info({ issue: 7 }, "current");
    logger.close();

    assert.equal(existsSync(oldLog), false);
    assert.equal(readLogLines(join(root, "2026-05-04.log"))[0].msg, "current");
  });

  it("keeps state write and audit emission in a single ordered critical section", () => {
    const root = makeTempDir();
    const order: string[] = [];
    const logger = createAutokitLogger({
      logDir: root,
      config: DEFAULT_CONFIG,
      now: () => new Date("2026-05-04T00:35:00.000Z"),
    });

    logger.writeStateAndAudit(
      () => {
        order.push("state");
      },
      { kind: "resumed", fields: { issue: 7 } },
    );
    logger.close();

    order.push(readLogLines(join(root, "2026-05-04.log"))[0].kind);
    assert.deepEqual(order, ["state", "resumed"]);
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autokit-logger-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

type LogLine = Record<string, unknown> & {
  level: string;
  msg: string;
  detail: string;
  envLine: string;
  event?: string;
  kind?: string;
  failure: { code: string; message: string };
  payload: { before_hmac: string; after_hmac: string };
};

function readLogLines(path: string): LogLine[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function extractSpecFailureCodes(spec: string): string[] {
  return [...extractSection(spec, "##### 4.2.1.1", "### 4.3").matchAll(/\| `([a-z_]+)` \|/g)]
    .map((match) => match[1])
    .sort();
}

function extractSpecFailureAuditKinds(spec: string): string[] {
  return [...extractSection(spec, "##### 10.2.2.2", "### 10.3").matchAll(/^- `([a-z_]+)`/gm)]
    .map((match) => match[1])
    .sort();
}

function extractSpecOperationalAuditKinds(spec: string): string[] {
  return [
    ...extractSection(spec, "##### 10.2.2.1", "##### 10.2.2.2").matchAll(/^\| `([a-z_]+)` \|/gm),
  ]
    .map((match) => match[1])
    .sort();
}

function extractSection(spec: string, start: string, end: string): string {
  const startIndex = spec.indexOf(start);
  const endIndex = spec.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return spec.slice(startIndex, endIndex);
}
