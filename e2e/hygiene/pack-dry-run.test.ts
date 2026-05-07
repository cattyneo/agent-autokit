import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildRunnerEnv } from "../../packages/core/src/env-allowlist.ts";

const ROOT = process.cwd();
const BUN = process.execPath;
const BUN_DIR = dirname(BUN);
const RUN_HYGIENE_GATE = process.env.AUTOKIT_RUN_HYGIENE_E2E === "1";
const HYGIENE_E2E_TIMEOUT_MS = 120_000;

const REQUIRED_PRESET_ENTRIES = [
  "assets/presets/default/config.yaml",
  "assets/presets/default/skills/autokit-implement/SKILL.md",
  "assets/presets/laravel-filament/config.yaml",
  "assets/presets/laravel-filament/skills/autokit-review/SKILL.md",
  "assets/presets/next-shadcn/config.yaml",
  "assets/presets/next-shadcn/prompts/implement.md",
  "assets/presets/docs-create/config.yaml",
  "assets/presets/docs-create/agents/reviewer.md",
];

const FORBIDDEN_PACK_PATTERNS = [
  "__MACOSX",
  ".DS_Store",
  ".claude/state",
  ".claude/sessions",
  ".claude/credentials",
  ".codex/auth",
  ".codex/credentials",
  ".env",
  ".env.",
  ".pem",
  "id_rsa",
];

const tempDirs: string[] = [];

describe("Issue #116 assets hygiene E2E gate", () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it("keeps pack contents, CLI bundle, and installed serve smoke release-safe", {
    timeout: HYGIENE_E2E_TIMEOUT_MS,
  }, async () => {
    if (!RUN_HYGIENE_GATE) {
      assert.equal(RUN_HYGIENE_GATE, false);
      return;
    }
    assertPrebuiltDistExists();
    const hygiene = run("/bin/bash", ["scripts/check-assets-hygiene.sh"], {
      parentEnv: process.env,
    });
    const hygieneOutput = `${hygiene.stdout}\n${hygiene.stderr}`;
    assert.match(hygieneOutput, /assets hygiene passed/);
    for (const entry of REQUIRED_PRESET_ENTRIES) {
      assert.match(extractBunPackOutput(hygieneOutput), new RegExp(escapeRegExp(entry)), entry);
    }
    for (const pattern of FORBIDDEN_PACK_PATTERNS) {
      assert.doesNotMatch(hygieneOutput, new RegExp(escapeRegExp(pattern)), pattern);
    }

    const cliPackage = JSON.parse(
      readFileSync(join(ROOT, "packages/cli/package.json"), "utf8"),
    ) as {
      private?: unknown;
    };
    assert.equal(cliPackage.private, true);

    const bundle = readFileSync(join(ROOT, "packages/cli/dist/bin.js"), "utf8");
    assert.doesNotMatch(bundle, /workspace:/);
    assert.doesNotMatch(
      bundle,
      /@cattyneo\/autokit-(core|workflows|claude-runner|codex-runner|tui|serve)/,
    );
    assert.match(bundle, /serve listening/);
    assert.match(bundle, /unsupported serve host/);
    assert.doesNotMatch(bundle, /packages\/dashboard|@cattyneo\/autokit-dashboard/);

    const tarball = packCliTarball();
    const installRoot = makeTempDir("autokit-hygiene-install-");
    run("npm", [
      "--cache",
      join(installRoot, "npm-cache"),
      "install",
      "--prefix",
      installRoot,
      tarball,
    ]);
    const autokitBin = join(installRoot, "node_modules", ".bin", "autokit");
    chmodSync(autokitBin, 0o755);
    await assertInstalledServeStarts(autokitBin);
  });

  it("fails closed when forbidden entries appear in pack output", () => {
    if (!RUN_HYGIENE_GATE) {
      assert.equal(RUN_HYGIENE_GATE, false);
      return;
    }
    assertPrebuiltDistExists();
    const fixtureRoot = makeTempDir("autokit-hygiene-forbidden-");
    const bunOutputPath = join(fixtureRoot, "bun-pack.txt");
    const npmOutputPath = join(fixtureRoot, "npm-pack.txt");
    const packOutput = [...REQUIRED_PRESET_ENTRIES, "packed 12B .env"].join("\n");
    writeFileSync(bunOutputPath, packOutput, { mode: 0o600 });
    writeFileSync(npmOutputPath, REQUIRED_PRESET_ENTRIES.join("\n"), { mode: 0o600 });

    const result = runExpectFailure("/bin/bash", ["scripts/check-assets-hygiene.sh"], {
      parentEnv: process.env,
      extraEnv: {
        AUTOKIT_ASSETS_HYGIENE_BUN_PACK_OUTPUT_FILE: bunOutputPath,
        AUTOKIT_ASSETS_HYGIENE_NPM_PACK_OUTPUT_FILE: npmOutputPath,
      },
    });
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /forbidden publish candidate entry: .*\.env/,
    );
  });
});

function packCliTarball(): string {
  const packRoot = makeTempDir("autokit-hygiene-pack-");
  const result = run("npm", [
    "--cache",
    join(packRoot, "npm-cache"),
    "pack",
    "--pack-destination",
    packRoot,
    "--workspace",
    "packages/cli",
  ]);
  const filename = result.stdout
    .trim()
    .split(/\r?\n/)
    .findLast((line) => line.endsWith(".tgz"));
  assert.ok(filename, result.stdout);
  return join(packRoot, filename);
}

async function assertInstalledServeStarts(autokitBin: string): Promise<void> {
  const repo = makeTempDir("autokit-hygiene-serve-repo-");
  const home = makeTempDir("autokit-hygiene-home-");
  const childEnv = buildRunnerEnv(parentEnvWithToolPath(process.env), { home });
  const child = spawn(autokitBin, ["serve", "--port", "0"], {
    cwd: repo,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );

  try {
    await waitForServeReady(
      () => stdout,
      () => stderr,
      exitPromise,
      5_000,
    );
    assert.match(stdout, /token file\t/);
    const port = parseServePort(stdout);
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      headers: { authorization: `Bearer ${readTokenFromServeOutput(stdout)}` },
    });
    assert.equal(response.status, 200);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill("SIGTERM");
    const exit = await Promise.race([
      exitPromise,
      new Promise<{ code: null; signal: null }>((resolveDone) => {
        setTimeout(() => resolveDone({ code: null, signal: null }), 1_000).unref();
      }),
    ]);
    assert.ok(
      exit.signal === "SIGTERM" || exit.code === 0,
      `serve exited unexpectedly\nexit:${JSON.stringify(exit)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  assert.doesNotMatch(stderr, /Cannot find module|ERR_MODULE_NOT_FOUND/);
}

function run(
  command: string,
  args: string[],
  options: { parentEnv?: NodeJS.ProcessEnv; extraEnv?: Record<string, string>; cwd?: string } = {},
): { stdout: string; stderr: string } {
  const runnerEnv = buildRunnerEnv(parentEnvWithToolPath(options.parentEnv ?? process.env));
  Object.assign(runnerEnv, options.extraEnv ?? {});
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: runnerEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(
    result.status,
    0,
    [
      `$ ${[command, ...args].join(" ")}`,
      `status: ${String(result.status)}`,
      result.stdout,
      result.stderr,
    ].join("\n"),
  );
  return { stdout: result.stdout, stderr: result.stderr };
}

function runExpectFailure(
  command: string,
  args: string[],
  options: { parentEnv?: NodeJS.ProcessEnv; extraEnv?: Record<string, string>; cwd?: string } = {},
): { stdout: string; stderr: string; status: number | null } {
  const runnerEnv = buildRunnerEnv(parentEnvWithToolPath(options.parentEnv ?? process.env));
  Object.assign(runnerEnv, options.extraEnv ?? {});
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: runnerEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.notEqual(
    result.status,
    0,
    [
      `$ ${[command, ...args].join(" ")}`,
      "expected command to fail",
      result.stdout,
      result.stderr,
    ].join("\n"),
  );
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function parentEnvWithToolPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PATH: `${BUN_DIR}:${env.PATH ?? ""}` };
}

async function waitForServeReady(
  stdout: () => string,
  stderr: () => string,
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  void exitPromise.then((exit) => {
    exited = exit;
  });
  while (!stdout().includes("serve listening")) {
    if (exited !== null) {
      throw new Error(
        `installed autokit serve exited before listening: ${JSON.stringify(exited)}\nstdout:\n${stdout()}\nstderr:\n${stderr()}`,
      );
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `timed out waiting for installed autokit serve to start\nstdout:\n${stdout()}\nstderr:\n${stderr()}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function parseServePort(stdout: string): number {
  const portText = stdout.match(/serve listening\thttp:\/\/127\.0\.0\.1:(\d+)/)?.[1];
  assert.ok(portText, stdout);
  return Number(portText);
}

function readTokenFromServeOutput(stdout: string): string {
  const tokenPath = stdout.match(/token file\t(.+)/)?.[1]?.trim();
  assert.ok(tokenPath, stdout);
  return readFileSync(tokenPath, "utf8").trim();
}

function assertPrebuiltDistExists(): void {
  assert.ok(
    existsSync(join(ROOT, "packages/cli/dist/bin.js")),
    "packages/cli/dist/bin.js is required; run bun run build before the hygiene E2E gate",
  );
}

function extractBunPackOutput(output: string): string {
  const end = output.indexOf("npm notice");
  return end === -1 ? output : output.slice(0, end);
}

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function cleanupTempDirs(): void {
  for (const path of tempDirs.splice(0).reverse()) {
    rmSync(path, { recursive: true, force: true });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
