import assert from "node:assert/strict";
import {
  chmodSync,
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

import { parseConfig } from "./config.ts";
import {
  type RunLockHooks,
  releaseRunLock,
  tryAcquireRunLock,
  waitAcquireRunLock,
} from "./process-lock.ts";

const NOW = new Date("2026-05-07T09:00:00.000Z");

describe("core process lock", () => {
  it("acquires with atomic directory creation, publishes mode-restricted holder, and releases by token", () => {
    const root = makeTempDir();
    const hooks = hooksFor({ token: "token-a", pid: 1234, lstart: "START-A" });

    const acquired = tryAcquireRunLock(root, { hooks });

    assert.equal(acquired.acquired, true);
    if (!acquired.acquired) {
      throw new Error("expected acquired lock");
    }
    assert.equal(statMode(join(root, ".autokit", ".lock")), 0o700);
    assert.equal(statMode(join(root, ".autokit", ".lock", "holder.json")), 0o600);
    const holder = JSON.parse(readFileSync(join(root, ".autokit", ".lock", "holder.json"), "utf8"));
    assert.deepEqual(
      {
        holder_token: holder.holder_token,
        pid: holder.pid,
        started_at_lstart: holder.started_at_lstart,
        host: holder.host,
        acquired_at: holder.acquired_at,
      },
      {
        holder_token: "token-a",
        pid: 1234,
        started_at_lstart: "START-A",
        host: "build-host",
        acquired_at: NOW.toISOString(),
      },
    );

    assert.equal(acquired.lock.release(), true);
    assert.equal(existsSync(join(root, ".autokit", ".lock")), false);
  });

  it("returns busy for a second acquire without exposing the holder token", () => {
    const root = makeTempDir();
    const first = tryAcquireRunLock(root, {
      hooks: hooksFor({ token: "fixture-a", pid: 1234, lstart: "START-A" }),
    });
    assert.equal(first.acquired, true);

    const second = tryAcquireRunLock(root, {
      hooks: hooksFor({ token: "token-b", pid: 2345, lstart: "START-B" }),
    });

    assert.equal(second.acquired, false);
    assert.equal(JSON.stringify(second).includes("fixture-a"), false);
  });

  it("fails closed on wrong-token release and keeps the active lock", () => {
    const root = makeTempDir();
    const acquired = tryAcquireRunLock(root, {
      hooks: hooksFor({ token: "token-a", pid: 1234, lstart: "START-A" }),
    });
    assert.equal(acquired.acquired, true);

    assert.equal(releaseRunLock(root, "wrong-token"), false);
    assert.equal(existsSync(join(root, ".autokit", ".lock", "holder.json")), true);
  });

  it("recovers missing or corrupt incomplete holders after the grace window", () => {
    for (const holder of ["missing", "corrupt", "invalid-pid"] as const) {
      const root = makeTempDir();
      const lockDir = join(root, ".autokit", ".lock");
      mkdirSync(lockDir, { recursive: true, mode: 0o700 });
      if (holder === "corrupt") {
        writeFileSync(join(lockDir, "holder.json"), "{", { mode: 0o600 });
      }
      if (holder === "invalid-pid") {
        writeHolder(root, {
          holder_token: "invalid",
          pid: 0,
          started_at_lstart: "START-A",
          host: "other-host",
          acquired_at: NOW.toISOString(),
        });
      }
      utimesSync(lockDir, new Date(0), new Date(0));

      const acquired = tryAcquireRunLock(root, {
        incompleteGraceMs: 0,
        hooks: hooksFor({ token: `token-${holder}`, pid: 1234, lstart: "START-A" }),
      });

      assert.equal(acquired.acquired, true, holder);
      assert.equal(statMode(lockDir), 0o700, holder);
    }
  });

  it("recovers dead stale holders but preserves live locks when pid lstart differs", () => {
    const staleRoot = makeTempDir();
    writeHolder(staleRoot, {
      holder_token: "stale-token",
      pid: 7777,
      started_at_lstart: "OLD",
      host: "other-host",
      acquired_at: NOW.toISOString(),
    });
    const recovered = tryAcquireRunLock(staleRoot, {
      hooks: hooksFor({ token: "fresh-token", pid: 1234, lstart: "START-A", alive: false }),
    });
    assert.equal(recovered.acquired, true);

    const liveRoot = makeTempDir();
    writeHolder(liveRoot, {
      holder_token: "live-token",
      pid: 8888,
      started_at_lstart: "OLD",
      host: "other-host",
      acquired_at: NOW.toISOString(),
    });
    const preserved = tryAcquireRunLock(liveRoot, {
      hooks: hooksFor({
        token: "c",
        pid: 1234,
        lstart: "START-A",
        alive: true,
        observedLstart: "NEW",
      }),
    });

    assert.equal(preserved.acquired, false);
    assert.equal(existsSync(join(liveRoot, ".autokit", ".lock", "holder.json")), true);
  });

  it("fails closed when stale recovery observes a replacement holder before removal", () => {
    const root = makeTempDir();
    writeHolder(root, {
      holder_token: "stale-token",
      pid: 7777,
      started_at_lstart: "OLD",
      host: "other-host",
      acquired_at: NOW.toISOString(),
    });
    let replaced = false;

    const acquired = tryAcquireRunLock(root, {
      hooks: {
        ...hooksFor({ token: "fresh-token", pid: 1234, lstart: "START-A", alive: false }),
        isProcessAlive: () => {
          if (!replaced) {
            replaced = true;
            writeHolder(root, {
              holder_token: "replacement-token",
              pid: 8888,
              started_at_lstart: "NEW",
              host: "other-host",
              acquired_at: NOW.toISOString(),
            });
          }
          return false;
        },
      },
    });

    assert.equal(acquired.acquired, false);
    assert.equal(JSON.stringify(acquired).includes("replacement-token"), false);
    const holder = JSON.parse(readFileSync(join(root, ".autokit", ".lock", "holder.json"), "utf8"));
    assert.equal(holder.holder_token, "replacement-token");
  });

  it("supports bounded waiting and timeout without using the wait API in fast-fail callers", async () => {
    const root = makeTempDir();
    const first = tryAcquireRunLock(root, {
      hooks: hooksFor({ token: "token-a", pid: 1234, lstart: "START-A" }),
    });
    assert.equal(first.acquired, true);

    const timedOut = await waitAcquireRunLock(root, {
      timeout_ms: 2,
      poll_interval_ms: 1,
      hooks: hooksFor({ token: "token-b", pid: 2345, lstart: "START-B" }),
    });
    assert.equal(timedOut.acquired, false);
    assert.equal(timedOut.reason, "timeout");

    let sleeps = 0;
    const waited = await waitAcquireRunLock(root, {
      timeout_ms: 100,
      poll_interval_ms: 1,
      hooks: hooksFor({
        token: "token-c",
        pid: 3456,
        lstart: "START-C",
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 1 && first.acquired) {
            first.lock.release();
          }
        },
      }),
    });
    assert.equal(waited.acquired, true);
  });

  it("prevents split-brain when a waiter and late contender race after release", async () => {
    const root = makeTempDir();
    const first = tryAcquireRunLock(root, {
      hooks: hooksFor({ token: "token-a", pid: 1234, lstart: "START-A" }),
    });
    assert.equal(first.acquired, true);
    let sleeps = 0;
    let lateAcquire: ReturnType<typeof tryAcquireRunLock> | null = null;

    const waited = await waitAcquireRunLock(root, {
      timeout_ms: 2,
      poll_interval_ms: 1,
      hooks: hooksFor({
        token: "token-b",
        pid: 2345,
        lstart: "START-B",
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 1 && first.acquired) {
            assert.equal(first.lock.release(), true);
            lateAcquire = tryAcquireRunLock(root, {
              hooks: hooksFor({ token: "token-c", pid: 3456, lstart: "START-C" }),
            });
          }
        },
      }),
    });

    assert.equal(waited.acquired, false);
    assert.equal(waited.reason, "timeout");
    assert.equal(lateAcquire?.acquired, true);
    const postReleaseOwners = [waited, lateAcquire].filter((result) => result?.acquired === true);
    assert.equal(postReleaseOwners.length, 1);
    const holder = JSON.parse(readFileSync(join(root, ".autokit", ".lock", "holder.json"), "utf8"));
    assert.equal(holder.holder_token, "token-c");
  });

  it("redacts host with the serve lock config when requested", () => {
    const root = makeTempDir();

    const acquired = tryAcquireRunLock(root, {
      config: parseConfig({ serve: { lock: { host_redact: true } } }),
      hooks: hooksFor({ token: "token-a", pid: 1234, lstart: "START-A" }),
    });

    assert.equal(acquired.acquired, true);
    const holder = JSON.parse(readFileSync(join(root, ".autokit", ".lock", "holder.json"), "utf8"));
    assert.match(holder.host, /^[a-f0-9]{16}$/);
    assert.notEqual(holder.host, "build-host");
  });
});

function hooksFor(input: {
  token: string;
  pid: number;
  lstart: string;
  alive?: boolean;
  observedLstart?: string;
  sleep?: (ms: number) => Promise<void>;
}): RunLockHooks {
  return {
    now: () => NOW,
    randomToken: () => input.token,
    hostname: () => "build-host.internal.example",
    pid: input.pid,
    getProcessLstart: () => input.observedLstart ?? input.lstart,
    isProcessAlive: () => input.alive ?? true,
    sleep: input.sleep ?? (async () => undefined),
  };
}

function writeHolder(root: string, holder: Record<string, unknown>): void {
  const lockDir = join(root, ".autokit", ".lock");
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  chmodSync(lockDir, 0o700);
  writeFileSync(join(lockDir, "holder.json"), JSON.stringify(holder), { mode: 0o600 });
  chmodSync(join(lockDir, "holder.json"), 0o600);
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autokit-process-lock-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}
