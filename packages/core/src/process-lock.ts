import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";

import { type AutokitConfig, DEFAULT_CONFIG } from "./config.js";

const LOCK_DIR = join(".autokit", ".lock");
const HOLDER_FILE = "holder.json";
const HOLDER_TMP_FILE = "holder.json.tmp";
const SEIZING_FILE = "holder.json.seizing";
const DEFAULT_INCOMPLETE_GRACE_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

export type RunLockHolder = {
  holder_token: string;
  pid: number;
  started_at_lstart: string;
  host: string;
  acquired_at: string;
  run_id?: string;
};

export type PublicRunLockHolder = Omit<RunLockHolder, "holder_token">;

export type RunLock = {
  holder: RunLockHolder;
  holderToken: string;
  release: () => boolean;
};

export type TryAcquireRunLockResult =
  | { acquired: true; lock: RunLock }
  | {
      acquired: false;
      reason: "busy" | "host_mismatch";
      holder: PublicRunLockHolder | null;
    };

export type ForceSeizeRunLockResult =
  | { seized: true; lock: RunLock; prior: PublicRunLockHolder }
  | {
      seized: false;
      reason: "no_holder" | "holder_changed" | "same_host" | "seize_failed";
      holder: PublicRunLockHolder | null;
    };

export type WaitAcquireRunLockResult =
  | { acquired: true; lock: RunLock }
  | { acquired: false; reason: "timeout"; holder: PublicRunLockHolder | null };

export type RunLockHooks = {
  now?: () => Date;
  randomToken?: () => string;
  hostname?: () => string;
  pid?: number;
  getProcessLstart?: (pid: number) => string | null;
  isProcessAlive?: (pid: number) => boolean;
  beforeForceSeizeRecheck?: () => void;
  sleep?: (ms: number) => Promise<void>;
};

export type TryAcquireRunLockOptions = {
  config?: AutokitConfig;
  hooks?: RunLockHooks;
  incompleteGraceMs?: number;
  runId?: string;
};

export type WaitAcquireRunLockOptions = TryAcquireRunLockOptions & {
  timeout_ms: number;
  poll_interval_ms?: number;
};

export function tryAcquireRunLock(
  repoRoot: string,
  options: TryAcquireRunLockOptions = {},
): TryAcquireRunLockResult {
  const context = lockContext(options);
  const lockDir = lockPath(repoRoot);
  mkdirSync(join(repoRoot, ".autokit"), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      chmodSync(lockDir, 0o700);
      const holder = createHolder(context, options.runId);
      publishHolder(lockDir, holder);
      return {
        acquired: true,
        lock: {
          holder,
          holderToken: holder.holder_token,
          release: () => releaseRunLock(repoRoot, holder.holder_token),
        },
      };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      const recovery = recoverExistingLock(repoRoot, context);
      if (recovery === "recovered") {
        continue;
      }
      return {
        acquired: false,
        reason: recovery.status,
        holder: recovery.holder === null ? null : publicHolder(recovery.holder),
      };
    }
  }

  return { acquired: false, reason: "busy", holder: null };
}

export function forceSeizeRunLock(
  repoRoot: string,
  options: TryAcquireRunLockOptions = {},
): ForceSeizeRunLockResult {
  const context = lockContext(options);
  const lockDir = lockPath(repoRoot);
  const holderPath = join(lockDir, HOLDER_FILE);
  const holder = readHolder(holderPath);
  if (holder === null || holder === "invalid") {
    return { seized: false, reason: "no_holder", holder: null };
  }
  if (!isHostMismatch(holder, context)) {
    return { seized: false, reason: "same_host", holder: publicHolder(holder) };
  }
  const prior = publicHolder(holder);
  const seizingPath = join(lockDir, SEIZING_FILE);
  try {
    writeFileSync(seizingPath, `${context.pid}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(seizingPath, 0o600);
  } catch {
    return { seized: false, reason: "seize_failed", holder: prior };
  }

  try {
    context.beforeForceSeizeRecheck();
    const reread = readHolder(holderPath);
    if (
      reread === null ||
      reread === "invalid" ||
      reread.holder_token !== holder.holder_token ||
      reread.pid !== holder.pid ||
      reread.started_at_lstart !== holder.started_at_lstart ||
      reread.host !== holder.host ||
      reread.acquired_at !== holder.acquired_at
    ) {
      return {
        seized: false,
        reason: "holder_changed",
        holder: reread === null || reread === "invalid" ? null : publicHolder(reread),
      };
    }

    const newHolder = createHolder(context, options.runId);
    publishHolder(lockDir, newHolder);
    return {
      seized: true,
      lock: {
        holder: newHolder,
        holderToken: newHolder.holder_token,
        release: () => releaseRunLock(repoRoot, newHolder.holder_token),
      },
      prior,
    };
  } finally {
    unlinkIfExists(seizingPath);
  }
}

export async function waitAcquireRunLock(
  repoRoot: string,
  options: WaitAcquireRunLockOptions,
): Promise<WaitAcquireRunLockResult> {
  const pollInterval = options.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
  let elapsed = 0;
  let lastHolder: PublicRunLockHolder | null = null;

  for (;;) {
    const acquired = tryAcquireRunLock(repoRoot, options);
    if (acquired.acquired) {
      return acquired;
    }
    lastHolder = acquired.holder;
    if (elapsed >= options.timeout_ms) {
      return { acquired: false, reason: "timeout", holder: lastHolder };
    }
    await (options.hooks?.sleep ?? defaultSleep)(pollInterval);
    elapsed += pollInterval;
  }
}

export function releaseRunLock(repoRoot: string, holderToken: string): boolean {
  const lockDir = lockPath(repoRoot);
  const holderPath = join(lockDir, HOLDER_FILE);
  const holder = readHolder(holderPath);
  if (holder === null || holder === "invalid" || holder.holder_token !== holderToken) {
    return false;
  }
  unlinkIfExists(holderPath);
  unlinkIfExists(join(lockDir, HOLDER_TMP_FILE));
  try {
    rmdirSync(lockDir);
    return true;
  } catch {
    return false;
  }
}

function lockContext(options: TryAcquireRunLockOptions) {
  const config = options.config ?? DEFAULT_CONFIG;
  const hooks = options.hooks ?? {};
  return {
    config,
    now: hooks.now ?? (() => new Date()),
    randomToken: hooks.randomToken ?? defaultToken,
    hostname: hooks.hostname ?? osHostname,
    pid: hooks.pid ?? process.pid,
    getProcessLstart: hooks.getProcessLstart ?? defaultProcessLstart,
    isProcessAlive: hooks.isProcessAlive ?? defaultProcessAlive,
    beforeForceSeizeRecheck: hooks.beforeForceSeizeRecheck ?? (() => undefined),
    incompleteGraceMs: options.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS,
  };
}

function createHolder(context: ReturnType<typeof lockContext>, runId: string | undefined) {
  const holder: RunLockHolder = {
    holder_token: context.randomToken(),
    pid: context.pid,
    started_at_lstart: context.getProcessLstart(context.pid) ?? context.now().toISOString(),
    host: formatHost(context.hostname(), context.config.serve.lock.host_redact),
    acquired_at: context.now().toISOString(),
  };
  if (runId !== undefined) {
    holder.run_id = runId;
  }
  return holder;
}

function publishHolder(lockDir: string, holder: RunLockHolder): void {
  const tmp = join(lockDir, HOLDER_TMP_FILE);
  const finalPath = join(lockDir, HOLDER_FILE);
  unlinkIfExists(tmp);
  writeFileSync(tmp, `${JSON.stringify(holder, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, finalPath);
  chmodSync(finalPath, 0o600);
}

function recoverExistingLock(
  repoRoot: string,
  context: ReturnType<typeof lockContext>,
): { status: "busy" | "host_mismatch"; holder: RunLockHolder | null } | "recovered" {
  const lockDir = lockPath(repoRoot);
  const holderPath = join(lockDir, HOLDER_FILE);
  const holder = readHolder(holderPath);
  if (holder === null || holder === "invalid") {
    return recoverIncompleteLock(lockDir, context) ? "recovered" : { status: "busy", holder: null };
  }

  if (isHostMismatch(holder, context)) {
    return { status: "host_mismatch", holder };
  }

  if (context.isProcessAlive(holder.pid)) {
    return { status: "busy", holder };
  }

  const reread = readHolder(holderPath);
  if (
    reread === null ||
    reread === "invalid" ||
    reread.holder_token !== holder.holder_token ||
    reread.pid !== holder.pid ||
    reread.started_at_lstart !== holder.started_at_lstart
  ) {
    return { status: "busy", holder: reread === "invalid" ? null : reread };
  }
  unlinkIfExists(holderPath);
  unlinkIfExists(join(lockDir, HOLDER_TMP_FILE));
  try {
    rmdirSync(lockDir);
    return "recovered";
  } catch {
    return { status: "busy", holder };
  }
}

function recoverIncompleteLock(lockDir: string, context: ReturnType<typeof lockContext>): boolean {
  const ageMs = context.now().getTime() - statSync(lockDir).mtimeMs;
  if (ageMs < context.incompleteGraceMs) {
    return false;
  }
  const entries = readdirSync(lockDir);
  if (!entries.every((entry) => entry === HOLDER_FILE || entry === HOLDER_TMP_FILE)) {
    return false;
  }
  for (const entry of entries) {
    unlinkIfExists(join(lockDir, entry));
  }
  try {
    rmdirSync(lockDir);
    return true;
  } catch {
    return false;
  }
}

function readHolder(path: string): RunLockHolder | "invalid" | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      typeof parsed.holder_token !== "string" ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.started_at_lstart !== "string" ||
      typeof parsed.host !== "string" ||
      typeof parsed.acquired_at !== "string" ||
      (parsed.run_id !== undefined && typeof parsed.run_id !== "string")
    ) {
      return "invalid";
    }
    return parsed as RunLockHolder;
  } catch {
    return "invalid";
  }
}

function publicHolder(holder: RunLockHolder): PublicRunLockHolder {
  const { holder_token: _holderToken, ...rest } = holder;
  return rest;
}

function isHostMismatch(holder: RunLockHolder, context: ReturnType<typeof lockContext>): boolean {
  return holder.host !== formatHost(context.hostname(), context.config.serve.lock.host_redact);
}

function formatHost(host: string, redact: boolean): string {
  const short = shortHostname(host);
  return redact ? createHash("sha256").update(short).digest("hex").slice(0, 16) : short;
}

function shortHostname(host: string): string {
  const normalized = host.trim().replace(/\.$/, "");
  if (normalized.length === 0 || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    return "unknown-host";
  }
  return normalized.split(".")[0] ?? normalized;
}

function defaultToken(): string {
  return randomBytes(32).toString("base64url");
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function defaultProcessLstart(pid: number): string | null {
  return pid === process.pid ? new Date(Date.now() - process.uptime() * 1_000).toISOString() : null;
}

function lockPath(repoRoot: string): string {
  return join(repoRoot, LOCK_DIR);
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
