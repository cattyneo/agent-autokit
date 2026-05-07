import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createTaskEntry, type TaskEntry, writeTasksFileAtomic } from "@cattyneo/autokit-core";

import { type ServeWorkflowInput, startAutokitServe } from "./index.ts";

const NOW = "2026-05-07T20:00:00.000Z";
const FAKE_OPENAI_KEY = `sk-${"1".repeat(22)}`;

describe("serve auth gate", () => {
  it("requires bearer before route resolution, enforces Host, regenerates token, and unlinks on close", async () => {
    const repo = makeRepo();
    const stateHome = makeTempDir();
    const first = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome,
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    const firstToken = first.token;

    assert.equal(firstToken.length, 43);
    assert.equal(await status(first, "/api/missing"), 401);
    assert.equal(await status(first, "/api/tasks", { authorization: "Bearer " }), 401);
    assert.equal(
      await status(first, "/api/missing", { authorization: `Bearer ${firstToken}` }),
      404,
    );
    assert.equal(
      await status(first, "/api/tasks", {
        authorization: `Bearer ${firstToken}`,
        host: "evil.example",
      }),
      403,
    );
    assert.equal(existsSync(first.tokenPath), true);
    await first.close();
    assert.equal(existsSync(first.tokenPath), false);

    const second = await startAutokitServe({
      repoRoot: repo,
      port: first.port,
      stateHome,
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    assert.notEqual(second.token, firstToken);
    assert.equal(
      await status(second, "/api/tasks", { authorization: `Bearer ${firstToken}` }),
      401,
    );
    await second.close();

    await assert.rejects(
      startAutokitServe({
        repoRoot: repo,
        host: "0.0.0.0",
        port: 0,
        stateHome,
        now: () => NOW,
        runWorkflow: async () => ({ status: "completed" }),
      }),
      /unsupported serve host/,
    );
    await assert.rejects(
      startAutokitServe({
        repoRoot: repo,
        host: "::",
        port: 0,
        stateHome,
        now: () => NOW,
        runWorkflow: async () => ({ status: "completed" }),
      }),
      /unsupported serve host/,
    );
    await assert.rejects(
      startAutokitServe({
        repoRoot: repo,
        host: "::1",
        port: 0,
        stateHome,
        now: () => NOW,
        runWorkflow: async () => ({ status: "completed" }),
      }),
      /unsupported serve host/,
    );
  });

  it("keeps token file modes stable across umask and isolates repo/port token paths", async () => {
    const originalUmask = process.umask();
    const stateHome = makeTempDir();
    const servers: Awaited<ReturnType<typeof startAutokitServe>>[] = [];
    try {
      for (const mask of [0o022, 0o027, 0o077]) {
        process.umask(mask);
        const server = await startAutokitServe({
          repoRoot: makeRepo(),
          port: 0,
          stateHome,
          now: () => NOW,
          runWorkflow: async () => ({ status: "completed" }),
        });
        servers.push(server);
        assert.equal(statSync(server.tokenPath).mode & 0o777, 0o600);
        assert.equal(statSync(join(server.tokenPath, "..")).mode & 0o777, 0o700);
      }

      assert.equal(new Set(servers.map((server) => server.tokenPath)).size, servers.length);
      const survivor = servers[1];
      const closed = servers.shift();
      await closed?.close();
      assert.equal(existsSync(survivor?.tokenPath ?? ""), true);
    } finally {
      process.umask(originalUmask);
      await Promise.all(servers.map((server) => server.close()));
    }
  });

  it("closes the listener when token file creation fails", async () => {
    const blockedStateHome = join(makeTempDir(), "state-home-file");
    writeFileSync(blockedStateHome, "not a directory\n");
    const port = await getFreePort();

    await assert.rejects(
      startAutokitServe({
        repoRoot: makeRepo(),
        port,
        stateHome: blockedStateHome,
        now: () => NOW,
        runWorkflow: async () => ({ status: "completed" }),
      }),
      /ENOTDIR|not a directory/,
    );

    const server = await startAutokitServe({
      repoRoot: makeRepo(),
      port,
      stateHome: makeTempDir(),
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    await server.close();
  });

  it("keeps bearer token comparison on timingSafeEqual", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const body = source.match(/function safeTokenEqual[\s\S]*?\n}/)?.[0] ?? "";

    assert.match(body, /timingSafeEqual/);
    assert.doesNotMatch(body, /Buffer\.compare/);
    assert.doesNotMatch(body, /supplied\s*===\s*expected|expected\s*===\s*supplied/);
  });

  it("accepts only Authorization bearer tokens and applies Host and Origin matrix before routing", async () => {
    const server = await startAutokitServe({
      repoRoot: makeRepo([task({ issue: 99, state: "queued" })]),
      port: 0,
      stateHome: makeTempDir(),
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });

    assert.equal(await status(server, `/api/tasks?token=${server.token}`), 401);
    assert.equal(await status(server, "/api/tasks", { cookie: `token=${server.token}` }), 401);
    assert.equal(
      await rawStatus(server, "/api/run", {
        method: "POST",
        headers: {
          host: `127.0.0.1:${server.port}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `token=${server.token}`,
      }),
      401,
    );

    for (const host of [
      `127.0.0.1:${server.port}`,
      `localhost:${server.port}`,
      `LOCALHOST:${server.port}`,
      `localhost.:${server.port}`,
      `[::1]:${server.port}`,
    ]) {
      assert.equal(await status(server, "/api/tasks", authHeaders(server, { host })), 200, host);
    }
    assert.equal(
      await status(
        server,
        "/api/tasks",
        authHeaders(server, { host: `evil.local:${server.port}` }),
      ),
      403,
    );
    for (const host of [
      `localhost.evil:${server.port}`,
      `localhost:${server.port}.evil`,
      `127.0.0.1:${server.port}.evil`,
      `127.0.0.1:${server.port + 1}`,
    ]) {
      assert.equal(await status(server, "/api/tasks", authHeaders(server, { host })), 403, host);
    }

    assert.equal(await status(server, "/api/tasks", authHeaders(server)), 200);
    assert.equal(
      await status(
        server,
        "/api/tasks",
        authHeaders(server, { origin: `http://127.0.0.1:${server.port}` }),
      ),
      200,
    );
    assert.equal(
      await status(
        server,
        "/api/tasks",
        authHeaders(server, { origin: `http://LOCALHOST:${server.port}` }),
      ),
      200,
    );
    assert.equal(
      await status(
        server,
        "/api/tasks",
        authHeaders(server, { origin: `http://localhost.:${server.port}` }),
      ),
      200,
    );
    assert.equal(
      await status(
        server,
        "/api/tasks",
        authHeaders(server, { origin: `http://[::1]:${server.port}` }),
      ),
      200,
    );
    assert.equal(
      await status(server, "/api/tasks", authHeaders(server, { origin: "https://evil.example" })),
      403,
    );
    assert.equal(await status(server, "/api/tasks", authHeaders(server, { origin: "null" })), 403);
    await server.close();
  });

  it("rejects mutating requests without application/json content type before dispatch", async () => {
    const calls: ServeWorkflowInput[] = [];
    const server = await startAutokitServe({
      repoRoot: makeRepo([task({ issue: 99, state: "queued" })]),
      port: 0,
      stateHome: makeTempDir(),
      now: () => NOW,
      runWorkflow: async (input) => {
        calls.push(input);
        return { status: "completed" };
      },
    });

    for (const path of ["/api/run", "/api/resume", "/api/retry", "/api/cleanup"]) {
      for (const [contentType, body] of [
        [undefined, "{}"],
        ["text/plain", "{}"],
        ["application/x-www-form-urlencoded", "issue=99"],
        ["multipart/form-data; boundary=abc", "--abc"],
      ] as const) {
        const response = await rawStatus(server, path, {
          method: "POST",
          headers: authHeaders(server, contentType === undefined ? {} : { contentType }),
          body,
        });
        assert.equal(response, 415, `${path} ${contentType ?? "missing"}`);
      }
    }
    assert.equal(calls.length, 0);
    await server.close();
  });
});

describe("serve read endpoints", () => {
  it("returns tasks, sanitized bounded logs, and redacted bounded diff", async () => {
    const entry = task({ issue: 99, state: "queued" });
    entry.plan.path = "docs/plans/impl-99.md";
    entry.review_findings = [
      { round: 1, accept_ids: ["Check"], reject_ids: [], reject_reasons: {} },
    ];
    entry.worktree_path = ".agents/worktrees/issue-99";
    const repo = makeRepo([entry]);
    const worktree = join(repo, entry.worktree_path);
    mkdirSync(join(repo, "docs", "plans"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repo, entry.plan.path), "# Plan 99\n");
    mkdirSync(join(repo, ".autokit", "logs"), { recursive: true });
    writeFileSync(
      join(repo, ".autokit", "logs", "2026-05-07.log"),
      `${JSON.stringify({
        issue: 99,
        level: "info",
        token: "raw-token",
        message: FAKE_OPENAI_KEY,
        padding: `日本語${"x".repeat(200)}`,
      })}\n`,
    );
    const diffInputs: Array<{ cwd: string; issue: number }> = [];
    const server = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome: makeTempDir(),
      now: () => NOW,
      readDiff: (input) => {
        diffInputs.push(input);
        return [
          "diff --git a/.env b/.env",
          "--- a/.env",
          "+++ b/.env",
          "+OPENAI_API_KEY=raw",
          "diff --git a/docs/example.md b/docs/example.md",
          "--- a/docs/example.md",
          "+++ b/docs/example.md",
          "+token sk-doc-secret",
          "+日本語のdiff本文",
        ].join("\n");
      },
      runWorkflow: async () => ({ status: "completed" }),
    });

    const tasks = await json(server, "/api/tasks");
    const tasksBody = tasks.body as { ok: boolean; tasks: Array<{ issue: number }> };
    assert.equal(tasks.status, 200);
    assert.equal(tasksBody.ok, true);
    assert.equal(tasksBody.tasks[0]?.issue, 99);

    const taskDetail = await json(server, "/api/tasks/99");
    assert.equal(taskDetail.status, 200);
    assert.equal((taskDetail.body.task as { issue?: number }).issue, 99);

    const plan = await json(server, "/api/tasks/99/plan");
    assert.equal(plan.status, 200);
    assert.equal(plan.body.markdown, "# Plan 99\n");

    const reviews = await json(server, "/api/tasks/99/reviews");
    assert.equal(reviews.status, 200);
    assert.equal(
      (reviews.body.reviews as Array<{ accept_ids: string[] }>)[0]?.accept_ids[0],
      "Check",
    );

    const logs = await json(server, "/api/tasks/99/logs?max_bytes=96");
    const logsBody = logs.body as {
      ok: boolean;
      logs: string;
      truncated: boolean;
      next_cursor?: string;
    };
    assert.equal(logs.status, 200);
    assert.equal(logsBody.ok, true);
    assert.equal(logsBody.truncated, true);
    assert.ok(logsBody.next_cursor);
    assert.match(logsBody.logs, /<REDACTED>/);
    assert.doesNotMatch(logsBody.logs, /\uFFFD/);
    assert.equal(logsBody.logs.includes("raw-token"), false);
    assert.equal(logsBody.logs.includes(FAKE_OPENAI_KEY), false);
    const nextLogs = await json(
      server,
      `/api/tasks/99/logs?max_bytes=96&cursor=${logsBody.next_cursor}`,
    );
    assert.equal(nextLogs.status, 200);
    assert.doesNotMatch(String(nextLogs.body.logs), /\uFFFD/);

    const diff = await json(server, "/api/tasks/99/diff?max_bytes=128");
    const diffBody = diff.body as { diff: string; truncated: boolean; next_cursor?: string };
    assert.equal(diff.status, 200);
    assert.deepEqual(diffInputs[0], { cwd: realpathSync(worktree), issue: 99 });
    assert.match(diffBody.diff, /\[REDACTED hunk:/);
    assert.doesNotMatch(diffBody.diff, /OPENAI_API_KEY=raw|sk-doc-secret/);
    if (diffBody.truncated) {
      assert.ok(diffBody.next_cursor);
      const nextDiff = await json(
        server,
        `/api/tasks/99/diff?max_bytes=128&cursor=${diffBody.next_cursor}`,
      );
      assert.equal(nextDiff.status, 200);
      assert.doesNotMatch(String(nextDiff.body.diff), /\uFFFD/);
    }

    assert.equal((await json(server, "/api/tasks/99/logs?max_bytes=65537")).status, 413);
    assert.equal((await json(server, "/api/tasks/99/diff?max_bytes=65537")).status, 413);
    await server.close();
  });
});

describe("serve mutating endpoints", () => {
  it("strict-validates request bodies, fails closed on provider API keys, preserves idempotency before lock, and maps lock contention to 409", async () => {
    const repo = makeRepo([task({ issue: 99, state: "queued" })]);
    const stateHome = makeTempDir();
    const audits: Array<Record<string, unknown>> = [];
    const gate = deferred<void>();
    const calls: ServeWorkflowInput[] = [];
    const server = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome,
      now: () => NOW,
      runId: () => "run-99",
      auditOperation: (kind, fields) => audits.push({ kind, ...fields }),
      runWorkflow: async (input) => {
        calls.push(input);
        await gate.promise;
        return { status: "completed" };
      },
    });

    const unknownKey = await post(server, "/api/run", { unexpected: true });
    assert.equal(unknownKey.status, 400);
    assert.equal(unknownKey.body.code, "bad_request");

    const preflight = await startAutokitServe({
      repoRoot: makeRepo([task({ issue: 100, state: "queued" })]),
      port: 0,
      stateHome: makeTempDir(),
      env: { ...process.env, OPENAI_API_KEY: "set" },
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    for (const [path, body] of [
      ["/api/run", { issue: 100 }],
      ["/api/resume", { issue: 100 }],
      ["/api/retry", { issue: 100 }],
      ["/api/cleanup", { issue: 100 }],
    ] as const) {
      const rejected = await post(preflight, path, body);
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.code, "provider_api_key_env");
    }
    await preflight.close();

    const accepted = await post(server, "/api/run", { issue: 99, idempotency_key: "same-key" });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.run_id, "run-99");
    assert.equal(
      existsSync(join(stateHome, "autokit", "runs", server.repoId, "run-99.json")),
      true,
    );

    const same = await post(server, "/api/run", { issue: 99, idempotency_key: "same-key" });
    assert.equal(same.status, 202);
    assert.equal(same.body.run_id, "run-99");
    assert.equal(calls.length, 1);

    const busy = await post(server, "/api/run", { issue: 99 });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, "serve_lock_busy");
    assert.equal(audits.at(-1)?.kind, "serve_lock_busy");

    gate.resolve();
    await server.waitForIdle();
    const record = JSON.parse(
      readFileSync(join(stateHome, "autokit", "runs", server.repoId, "run-99.json"), "utf8"),
    ) as { status?: unknown };
    assert.equal(record.status, "completed");
    await server.close();
  });

  it("runs cleanup through the coordinator seam with a synchronous cleaned count", async () => {
    const calls: ServeWorkflowInput[] = [];
    const server = await startAutokitServe({
      repoRoot: makeRepo([task({ issue: 99, state: "merged" })]),
      port: 0,
      stateHome: makeTempDir(),
      now: () => NOW,
      runWorkflow: async (input) => {
        calls.push(input);
        return { status: "completed", cleaned: 1 };
      },
    });

    const response = await post(server, "/api/cleanup", { issue: 99, merged_only: true });

    assert.equal(response.status, 200);
    assert.equal(response.body.cleaned, 1);
    assert.equal(calls[0]?.operation, "cleanup");
    assert.equal(calls[0]?.merged_only, true);
    await server.close();
  });

  it("accepts resume and retry with operation-specific request validation", async () => {
    const repo = makeRepo([
      task({ issue: 99, state: "paused" }),
      task({ issue: 100, state: "failed" }),
    ]);
    const calls: ServeWorkflowInput[] = [];
    const server = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome: makeTempDir(),
      now: () => NOW,
      runId: (() => {
        let next = 0;
        return () => {
          next += 1;
          return `run-op-${next}`;
        };
      })(),
      runWorkflow: async (input) => {
        calls.push(input);
        return { status: "completed" };
      },
    });

    const resume = await post(server, "/api/resume", { issue: 99 });
    assert.equal(resume.status, 202);
    assert.equal(resume.body.run_id, "run-op-1");
    await server.waitForIdle();

    const retryMissingIssue = await post(server, "/api/retry", {});
    assert.equal(retryMissingIssue.status, 400);

    const retry = await post(server, "/api/retry", { issue: 100 });
    assert.equal(retry.status, 202);
    assert.equal(retry.body.run_id, "run-op-2");
    await server.waitForIdle();

    assert.deepEqual(
      calls.map((call) => [call.operation, call.issue]),
      [
        ["resume", 99],
        ["retry", 100],
      ],
    );
    await server.close();
  });

  it("rejects active task conflicts without changing tasks.yaml", async () => {
    const repo = makeRepo([task({ issue: 99, state: "implementing" })]);
    const before = readFileSync(join(repo, ".autokit", "tasks.yaml"), "utf8");
    const server = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome: makeTempDir(),
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });

    const response = await post(server, "/api/run", { issue: 99 });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "active_task");
    assert.equal(readFileSync(join(repo, ".autokit", "tasks.yaml"), "utf8"), before);
    await server.close();
  });

  it("marks accepted or running run records as resume_required on restart", async () => {
    const repo = makeRepo([task({ issue: 99, state: "implementing" })]);
    const stateHome = makeTempDir();
    const first = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome,
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    const recordDir = join(stateHome, "autokit", "runs", first.repoId);
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, "run-crashed.json"),
      `${JSON.stringify({
        run_id: "run-crashed",
        repo_id: first.repoId,
        operation: "run",
        issue: 99,
        status: "running",
        accepted_at: NOW,
        updated_at: NOW,
      })}\n`,
    );
    await first.close();

    const restarted = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome,
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    const response = await post(restarted, "/api/run", { issue: 99 });

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "resume_required");
    assert.equal(response.body.run_id, "run-crashed");
    await restarted.close();
  });
});

describe("serve SSE smoke", () => {
  it("opens an authenticated SSE stream with event-stream headers", async () => {
    const server = await startAutokitServe({
      repoRoot: makeRepo(),
      port: 0,
      stateHome: makeTempDir(),
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    const response = await rawGet(server, "/api/events");

    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"] ?? "", /text\/event-stream/);
    await server.close();
  });

  it("closes active SSE streams before unlinking the token on shutdown", async () => {
    const server = await startAutokitServe({
      repoRoot: makeRepo(),
      port: 0,
      stateHome: makeTempDir(),
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    await openSse(server, "/api/events");
    assert.equal(existsSync(server.tokenPath), true);

    await server.close();

    assert.equal(existsSync(server.tokenPath), false);
  });
});

function task(input: { issue: number; state: TaskEntry["state"] }): TaskEntry {
  const entry = createTaskEntry({
    issue: input.issue,
    slug: `issue-${input.issue}`,
    title: `Issue ${input.issue}`,
    labels: ["agent-ready"],
    now: NOW,
  });
  entry.state = input.state;
  return entry;
}

function makeRepo(tasks: TaskEntry[] = []): string {
  const root = makeTempDir();
  mkdirSync(join(root, ".autokit"), { recursive: true });
  writeTasksFileAtomic(join(root, ".autokit", "tasks.yaml"), {
    version: 1,
    generated_at: NOW,
    tasks,
  });
  writeFileSync(join(root, ".autokit", "config.yaml"), "version: 1\n");
  return root;
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "autokit-serve-"));
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  assert.notEqual(address, null);
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

function authHeaders(
  server: { token: string; port: number },
  overrides: { host?: string; origin?: string; contentType?: string } = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${server.token}`,
    host: overrides.host ?? `127.0.0.1:${server.port}`,
    ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
    ...(overrides.contentType === undefined ? {} : { "content-type": overrides.contentType }),
  };
}

async function status(
  server: { url(path: string): string; token?: string; port: number },
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const response = await fetch(server.url(path), { headers });
  await response.body?.cancel();
  return response.status;
}

async function rawStatus(
  server: { url(path: string): string; token?: string; port: number },
  path: string,
  init: RequestInit,
): Promise<number> {
  const response = await fetch(server.url(path), init);
  await response.body?.cancel();
  return response.status;
}

async function json(
  server: { url(path: string): string; token: string; port: number },
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(server.url(path), { headers: authHeaders(server) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function post(
  server: { url(path: string): string; token: string; port: number },
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(server.url(path), {
    method: "POST",
    headers: {
      ...authHeaders(server),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function rawGet(
  server: { url(path: string): string; token: string; port: number },
  path: string,
): Promise<{ status: number | undefined; headers: IncomingHttpHeaders }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(server.url(path), { headers: authHeaders(server) }, (response) => {
      resolve({ status: response.statusCode, headers: response.headers });
      response.destroy();
    });
    request.on("error", reject);
    request.end();
  });
}

async function openSse(
  server: { url(path: string): string; token: string; port: number },
  path: string,
): Promise<{
  request: ReturnType<typeof httpRequest>;
  response: import("node:http").IncomingMessage;
}> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(server.url(path), { headers: authHeaders(server) }, (response) => {
      resolve({ request, response });
    });
    request.on("error", reject);
    request.end();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
