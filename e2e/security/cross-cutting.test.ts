import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { validateClaudeToolUseInput } from "../../packages/claude-runner/src/index.ts";
import { type CliDeps, runCli } from "../../packages/cli/src/index.ts";
import {
  createTaskEntry,
  manifestDirectory,
  parseConfig,
  type TaskEntry,
  type WriteTaskInput,
  writeTasksFileAtomic,
} from "../../packages/core/src/index.ts";
import { type AutokitServeServer, startAutokitServe } from "../../packages/serve/src/index.ts";
import {
  type ImplementFixGitDeps,
  runImplementWorkflow,
  type WorkflowRunner,
} from "../../packages/workflows/src/index.ts";

const NOW = "2026-05-08T12:00:00.000Z";
const OPENAI_KEY = `sk-${"4".repeat(24)}`;
const GITHUB_TOKEN = `ghp_${"5".repeat(24)}`;
const PRIVATE_KEY_BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const AUTH_PATH = "/Users/security/.codex/auth.json";
const CLAUDE_CREDENTIALS_PATH = "/Users/security/.claude/credentials.json";
const ATTACKER_FILENAME = "attacker-secret-name.pem";

describe("Issue #114 security E2E gate", () => {
  it("covers bearer, Host, Origin, token reuse, token placement, and token file modes", async () => {
    for (const mask of [0o022, 0o027, 0o077]) {
      const previous = process.umask(mask);
      let server: AutokitServeServer | null = null;
      try {
        server = await startAutokitServe({
          repoRoot: makeRepo([task(11401)]),
          port: 0,
          stateHome: makeTempDir(),
          now: () => NOW,
          runWorkflow: async () => ({ status: "completed" }),
        });
        assert.equal(statSync(server.tokenPath).mode & 0o777, 0o600, `umask ${mask.toString(8)}`);
        assert.equal(
          statSync(dirname(server.tokenPath)).mode & 0o777,
          0o700,
          `umask ${mask.toString(8)}`,
        );
      } finally {
        process.umask(previous);
        await server?.close();
      }
    }

    const stateHome = makeTempDir();
    const repo = makeRepo([task(11402)]);
    const first = await startAutokitServe({
      repoRoot: repo,
      port: 0,
      stateHome,
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    const oldToken = first.token;
    const port = first.port;
    assert.equal(existsSync(first.tokenPath), true);
    await first.close();
    assert.equal(existsSync(first.tokenPath), false);

    const server = await startAutokitServe({
      repoRoot: repo,
      port,
      stateHome,
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    assert.notEqual(server.token, oldToken);
    assert.equal(await status(server, "/api/tasks", headers(server, { token: oldToken })), 401);
    assert.equal(
      await status(
        server,
        "/api/tasks",
        headers(server, { token: equalLengthWrongToken(server.token) }),
      ),
      401,
    );
    assert.equal(await status(server, "/api/tasks"), 401);
    assert.equal(await status(server, `/api/tasks?token=${encodeURIComponent(server.token)}`), 401);
    assert.equal(await status(server, "/api/tasks", { cookie: `token=${server.token}` }), 401);
    assert.equal(
      await rawStatus(server, "/api/run", {
        method: "POST",
        headers: {
          host: `127.0.0.1:${server.port}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `token=${encodeURIComponent(server.token)}`,
      }),
      401,
    );

    for (const host of [
      `127.0.0.1:${server.port}`,
      `LOCALHOST:${server.port}`,
      `localhost.:${server.port}`,
      `[::1]:${server.port}`,
    ]) {
      assert.equal(await status(server, "/api/tasks", headers(server, { host })), 200, host);
    }
    assert.equal(await status(server, "/api/tasks", headers(server)), 200);
    assert.equal(
      await status(
        server,
        "/api/tasks",
        headers(server, { origin: `http://localhost:${server.port}` }),
      ),
      200,
    );
    assert.equal(await status(server, "/api/tasks", headers(server, { origin: "null" })), 403);
    assert.equal(
      await status(server, "/api/tasks", headers(server, { origin: "https://evil.example" })),
      403,
    );
    assert.equal(
      await status(server, "/api/tasks", headers(server, { host: "evil.example" })),
      403,
    );
    await server.close();
  });

  it("redacts bearer, auth paths, API keys, and prompt_contract data from SSE events", async () => {
    const server = await startAutokitServe({
      repoRoot: makeRepo(
        [task(11403)],
        [
          "version: 1",
          "logging:",
          "  level: debug",
          "  redact_patterns:",
          "    - prompt-contract-secret",
        ].join("\n"),
      ),
      port: 0,
      stateHome: makeTempDir(),
      now: () => NOW,
      runWorkflow: async () => ({ status: "completed" }),
    });
    const stream = await openSse(server, "/api/events");
    server.publishEvent({
      kind: "runner_stdout",
      data: {
        issue: 11403,
        phase: "implement",
        chunk: [
          `Bearer ${server.token}`,
          OPENAI_KEY,
          GITHUB_TOKEN,
          AUTH_PATH,
          CLAUDE_CREDENTIALS_PATH,
          '{"prompt_contract":{"data":{"answer":"prompt-contract-secret"}}}',
          '{"token":"codex-subscription-secret"}',
        ].join(" "),
        at: NOW,
      },
    });
    const frame = await waitForSseFrame(
      stream.response,
      (candidate) => candidate.event === "runner_stdout",
    );
    const payload = JSON.stringify(frame.data);
    assertNoLiteralLeak(payload, [
      server.token,
      OPENAI_KEY,
      GITHUB_TOKEN,
      AUTH_PATH,
      CLAUDE_CREDENTIALS_PATH,
      "prompt-contract-secret",
      "codex-subscription-secret",
    ]);
    assert.match(payload, /<REDACTED>|~/);
    stream.response.destroy();
    await server.close();
  });

  it("redacts autokit diff output and fails preset security cases with category-only evidence", async () => {
    const repo = makeRepo();
    const stateHome = makeTempDir();
    const init = makeCliHarness(repo, {
      env: { XDG_STATE_HOME: stateHome, HOME: "/Users/security" },
    });
    assert.equal(await runCli(["init"], init.deps), 0);
    const tasksBefore = readTasksYaml(repo);
    const agentsBefore = manifestDirectory(join(repo, ".agents"));

    const diff = makeCliHarness(repo, {
      env: { HOME: "/Users/security" },
      execFile: (command, args) => {
        assert.equal(command, "git");
        assert.deepEqual(args, ["diff", "--no-ext-diff", "HEAD", "--"]);
        return [
          "diff --git a/.env b/.env",
          "--- a/.env",
          "+++ b/.env",
          `+OPENAI_API_KEY=${OPENAI_KEY}`,
          "diff --git a/docs/security.md b/docs/security.md",
          "--- a/docs/security.md",
          "+++ b/docs/security.md",
          `+token ${GITHUB_TOKEN}`,
          `+${PRIVATE_KEY_BEGIN}`,
          "+cHJpdmF0ZWtleWJvZHk=",
        ].join("\n");
      },
    });
    assert.equal(await runCli(["diff", "--issue", "114"], diff.deps), 0);
    assertNoLiteralLeak(diff.stdout(), [
      OPENAI_KEY,
      GITHUB_TOKEN,
      PRIVATE_KEY_BEGIN,
      "cHJpdmF0ZWtleWJvZHk",
    ]);
    assert.match(diff.stdout(), /\[REDACTED hunk: (?:\.env|<REDACTED>)\]/);

    makePreset(repo, "bad-env", "prompts/.env.production", "not persisted\n");
    const badEnv = makeCliHarness(repo, {
      env: { XDG_STATE_HOME: stateHome, HOME: "/Users/security" },
    });
    assert.equal(await runCli(["preset", "apply", "bad-env"], badEnv.deps), 1);
    assert.match(badEnv.stderr(), /preset_blacklist_hit: <blacklist:env>/);
    assertNoLiteralLeak(badEnv.stderr(), [".env.production", "not persisted"]);
    assert.equal(readTasksYaml(repo), tasksBefore);
    assert.deepEqual(manifestDirectory(join(repo, ".agents")), agentsBefore);

    makePreset(repo, "bad-codex", ".codex/auth.json", `{"token":"${GITHUB_TOKEN}"}\n`);
    const badCodex = makeCliHarness(repo, {
      env: { XDG_STATE_HOME: stateHome, HOME: "/Users/security" },
    });
    assert.equal(await runCli(["preset", "apply", "bad-codex"], badCodex.deps), 1);
    assert.match(badCodex.stderr(), /preset_blacklist_hit: <blacklist:credentials>/);
    assertNoLiteralLeak(badCodex.stderr(), ["auth.json", GITHUB_TOKEN]);
    assert.equal(readTasksYaml(repo), tasksBefore);

    makePreset(repo, "bad-content", "prompts/readme.md", `${PRIVATE_KEY_BEGIN}\nbody\n`);
    const badContent = makeCliHarness(repo, {
      env: { XDG_STATE_HOME: stateHome, HOME: "/Users/security" },
    });
    assert.equal(await runCli(["preset", "apply", "bad-content"], badContent.deps), 1);
    assert.match(
      badContent.stderr(),
      /preset_blacklist_hit: <content-signature:openssh-private-key>/,
    );
    assertNoLiteralLeak(badContent.stderr(), [PRIVATE_KEY_BEGIN, "body"]);

    makePreset(repo, "safe", "prompts/ok.md", "safe\n");
    rmSync(join(repo, ".agents"), { recursive: true, force: true });
    mkdirSync(join(repo, "outside-agents"), { recursive: true });
    symlinkSync(join(repo, "outside-agents"), join(repo, ".agents"));
    const traversal = makeCliHarness(repo, {
      env: { XDG_STATE_HOME: stateHome, HOME: "/Users/security" },
    });
    assert.equal(await runCli(["preset", "apply", "safe"], traversal.deps), 1);
    assert.match(traversal.stderr(), /preset_path_traversal: <symlink>/);
    assertNoLiteralLeak(traversal.stderr(), ["outside-agents", "safe/prompts/ok.md"]);
    assert.equal(readTasksYaml(repo), tasksBefore);

    const audits = JSON.stringify(readAuditEvents(repo));
    assert.match(
      audits,
      /<blacklist:env>|<blacklist:credentials>|<content-signature:openssh-private-key>|<symlink>/,
    );
    assertNoLiteralLeak(audits, [
      ".env.production",
      "auth.json",
      GITHUB_TOKEN,
      PRIVATE_KEY_BEGIN,
      "outside-agents",
      "safe/prompts/ok.md",
    ]);
  });

  it("denies write_path_guard writes to secret paths", () => {
    const workspaceRoot = makeTempDir();
    for (const filePath of [
      ".env",
      ".codex/auth.json",
      ".claude/credentials.json",
      "id_rsa",
      "keys/deploy.pem",
      "keys/prod.key",
    ]) {
      const decision = validateClaudeToolUseInput({
        hook: "write_path_guard",
        tool_name: "Write",
        tool_input: { file_path: filePath, content: "blocked" },
        workspaceRoot,
      });
      assert.equal(decision.ok, false, filePath);
      assert.match(decision.ok ? "" : decision.reason, /secret .*path denied/, filePath);
    }
  });

  it("keeps new failure messages and audit details sanitized", async () => {
    const unsupportedConfig = parseConfig({
      effort: { unsupported_policy: "fail" },
      phases: { implement: { provider: "codex", effort: "high", model: "gpt-5.4-mini" } },
    });
    const failed = await runImplementWorkflow(implementReadyTask(), {
      runner: queueRunner(),
      git: mockGitDeps(),
      repoRoot: "/repo/root",
      worktreeRoot: "/repo/root/.autokit/worktrees/issue-114",
      homeDir: "/Users/security",
      config: unsupportedConfig,
      now: () => NOW,
    });
    assert.equal(failed.task.state, "failed");
    assert.equal(failed.task.failure?.code, "effort_unsupported");
    assert.match(
      failed.task.failure?.message ?? "",
      /effort=high provider=codex model=gpt-5\.4-mini/,
    );
    assertNoLiteralLeak(failed.task.failure?.message ?? "", ["/Users/security", "/repo/root"]);

    const repo = makeRepo();
    const stateHome = makeTempDir();
    const init = makeCliHarness(repo, {
      env: { XDG_STATE_HOME: stateHome, HOME: "/Users/security" },
    });
    assert.equal(await runCli(["init"], init.deps), 0);

    makePreset(repo, "attacker-name", `prompts/${ATTACKER_FILENAME}`, "payload\n");
    const pathTraversal = makeCliHarness(repo, {
      env: { XDG_STATE_HOME: stateHome, HOME: "/Users/security" },
    });
    assert.equal(await runCli(["preset", "apply", "attacker-name"], pathTraversal.deps), 1);
    assert.match(pathTraversal.stderr(), /preset_blacklist_hit: <blacklist:ssh-key>/);
    assertNoLiteralLeak(pathTraversal.stderr(), [ATTACKER_FILENAME, "/Users/security", repo]);

    makePreset(repo, "protected-array", "config.yaml", "logging:\n  redact_patterns: []\n");
    const protectedArray = makeCliHarness(repo, {
      env: { XDG_STATE_HOME: stateHome, HOME: "/Users/security" },
    });
    assert.equal(await runCli(["preset", "apply", "protected-array"], protectedArray.deps), 1);
    assert.match(
      protectedArray.stderr(),
      /preset_blacklist_hit: <protected-array:logging\.redact_patterns>/,
    );
    assertNoLiteralLeak(protectedArray.stderr(), ["redact_patterns: []", "/Users/security", repo]);

    const audits = JSON.stringify(readAuditEvents(repo));
    assertNoLiteralLeak(audits, [
      ATTACKER_FILENAME,
      "redact_patterns: []",
      "/Users/security",
      repo,
    ]);
  });
});

function task(issue: number): TaskEntry {
  return createTaskEntry({
    issue,
    slug: `issue-${issue}`,
    title: `Issue ${issue}`,
    labels: ["agent-ready"],
    now: NOW,
  });
}

function implementReadyTask(): TaskEntry {
  const entry = task(11404);
  entry.state = "planned";
  entry.branch = "codex/issue-114";
  entry.worktree_path = ".autokit/worktrees/issue-114";
  entry.plan.state = "verified";
  return entry;
}

function queueRunner(): WorkflowRunner {
  return async () => {
    throw new Error("unsupported effort must fail before runner dispatch");
  };
}

function mockGitDeps(): ImplementFixGitDeps {
  return {
    getHeadSha: () => "head-sha",
    stageAll: () => undefined,
    commit: () => "commit-sha",
    pushBranch: () => undefined,
    createDraftPr: () => 114,
    getPrHead: () => ({ headSha: "commit-sha", baseSha: "base-sha" }),
    markPrReady: () => undefined,
  };
}

function makeRepo(tasks: TaskEntry[] = [], config = "version: 1\n"): string {
  const root = makeTempDir();
  mkdirSync(join(root, ".autokit"), { recursive: true });
  writeFileSync(join(root, ".autokit", ".gitignore"), "*\n!.gitignore\n!config.yaml\n", {
    mode: 0o600,
  });
  writeFileSync(join(root, ".autokit", "config.yaml"), `${config.trimEnd()}\n`, { mode: 0o600 });
  writeTasksFileAtomic(tasksPath(root), {
    version: 1,
    generated_at: NOW,
    tasks,
  } satisfies WriteTaskInput);
  return root;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autokit-security-e2e-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePreset(repo: string, name: string, relativePath: string, content: string): void {
  const absolutePath = join(repo, ".autokit", "presets", name, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, { mode: 0o600 });
}

function makeCliHarness(
  cwd: string,
  overrides: Partial<CliDeps> = {},
): { deps: CliDeps; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    deps: {
      cwd,
      env: {},
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
      execFile: () => "",
      now: () => NOW,
      ...overrides,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function headers(
  server: Pick<AutokitServeServer, "token" | "port">,
  overrides: { token?: string; host?: string; origin?: string } = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${overrides.token ?? server.token}`,
    host: overrides.host ?? `127.0.0.1:${server.port}`,
    ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
  };
}

async function status(
  server: Pick<AutokitServeServer, "url" | "token" | "port">,
  path: string,
  requestHeaders: Record<string, string> = {},
): Promise<number> {
  const response = await fetch(server.url(path), { headers: requestHeaders });
  await response.body?.cancel();
  return response.status;
}

async function rawStatus(
  server: Pick<AutokitServeServer, "url" | "token" | "port">,
  path: string,
  init: RequestInit,
): Promise<number> {
  const response = await fetch(server.url(path), init);
  await response.body?.cancel();
  return response.status;
}

async function openSse(
  server: Pick<AutokitServeServer, "url" | "token" | "port">,
  path: string,
): Promise<{ request: ReturnType<typeof httpRequest>; response: IncomingMessage }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(server.url(path), { headers: headers(server) }, (response) =>
      resolve({ request, response }),
    );
    request.on("error", reject);
    request.end();
  });
}

type SseFrame = { id?: string; event?: string; data: Record<string, unknown> };

async function waitForSseFrame(
  response: IncomingMessage,
  predicate: (frame: SseFrame) => boolean,
): Promise<SseFrame> {
  response.setEncoding("utf8");
  let buffer = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for SSE frame: ${buffer}`)),
      2000,
    );
    response.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const frame = parseSseFrame(part);
        if (frame !== null && predicate(frame)) {
          clearTimeout(timer);
          resolve(frame);
          return;
        }
      }
    });
    response.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function parseSseFrame(raw: string): SseFrame | null {
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0 && !line.startsWith(":"));
  if (lines.length === 0) return null;
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("id:")) id = line.slice("id:".length).trimStart();
    if (line.startsWith("event:")) event = line.slice("event:".length).trimStart();
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  return { id, event, data: JSON.parse(data.join("")) as Record<string, unknown> };
}

function readTasksYaml(repo: string): string {
  return readFileSync(tasksPath(repo), "utf8");
}

function tasksPath(repo: string): string {
  return join(repo, ".autokit", "tasks.yaml");
}

function readAuditEvents(repo: string): Array<Record<string, unknown> & { kind: string }> {
  const logDir = join(repo, ".autokit", "logs");
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .flatMap((entry) =>
      readFileSync(join(logDir, entry), "utf8")
        .trim()
        .split(/\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown> & { kind?: string }),
    )
    .filter(
      (entry): entry is Record<string, unknown> & { kind: string } =>
        typeof entry.kind === "string",
    );
}

function assertNoLiteralLeak(value: string, literals: string[]): void {
  for (const literal of literals) {
    assert.equal(value.includes(literal), false, `leaked literal: ${literal}`);
  }
}

function equalLengthWrongToken(token: string): string {
  return `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
}
