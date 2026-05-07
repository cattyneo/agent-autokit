import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { buildRunnerEnv } from "../../packages/core/src/env-allowlist.ts";

const ROOT = process.cwd();
const BUN = process.execPath;
const BUN_DIR = dirname(BUN);

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

describe("Issue #116 assets hygiene E2E gate", () => {
  it("keeps pack contents, CLI bundle, and installed serve smoke release-safe", async () => {
    run(BUN, ["run", "build"]);

    const hygiene = run("/bin/bash", ["scripts/check-assets-hygiene.sh"], {
      parentEnv: process.env,
    });
    const hygieneOutput = `${hygiene.stdout}\n${hygiene.stderr}`;
    assert.match(hygieneOutput, /assets hygiene passed/);
    for (const entry of REQUIRED_PRESET_ENTRIES) {
      assert.match(hygieneOutput, new RegExp(escapeRegExp(entry)), entry);
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
    const installRoot = mkdtempSync(join(tmpdir(), "autokit-hygiene-install-"));
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
});

function packCliTarball(): string {
  const packRoot = mkdtempSync(join(tmpdir(), "autokit-hygiene-pack-"));
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
  const repo = mkdtempSync(join(tmpdir(), "autokit-hygiene-serve-repo-"));
  const home = mkdtempSync(join(tmpdir(), "autokit-hygiene-home-"));
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

  try {
    await waitFor(() => stdout.includes("serve listening"), 5_000);
    assert.match(stdout, /token file\t/);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolveDone) => {
      child.once("exit", () => resolveDone());
      setTimeout(resolveDone, 1_000).unref();
    });
  }

  assert.doesNotMatch(stderr, /Cannot find module|ERR_MODULE_NOT_FOUND/);
}

function run(
  command: string,
  args: string[],
  options: { parentEnv?: NodeJS.ProcessEnv; cwd?: string } = {},
): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: buildRunnerEnv(parentEnvWithToolPath(options.parentEnv ?? process.env)),
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

function parentEnvWithToolPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PATH: `${BUN_DIR}:${env.PATH ?? ""}` };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for installed autokit serve to start");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
