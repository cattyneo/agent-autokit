import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  buildRunnerEnv,
  derive_claude_perm,
  type EffectivePermission,
  type Phase,
  promptContractForPhase,
  type ResolvedEffort,
  validateCapabilitySelection,
} from "@cattyneo/autokit-core";

import {
  buildClaudeArgs,
  buildClaudeAuthProbeArgs,
  buildClaudeEffortProfile,
  buildClaudePathGuardSettings,
  buildClaudeRunnerEnv,
  type ClaudeChildProcess,
  ClaudeRunnerError,
  parseClaudeCliJson,
  probeClaudeSubscriptionAuth,
  runClaude,
  type SpawnClaudeProcess,
  validateClaudeToolPathInput,
  validateClaudeToolUseInput,
} from "./index.ts";

const workspaceRoot = realpathSync.native(process.cwd());
const testChildEnv = buildRunnerEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin" });
const baseInput = {
  provider: "claude" as const,
  phase: "plan" as const,
  cwd: workspaceRoot,
  prompt: "Return prompt_contract YAML",
  promptContract: "plan" as const,
  model: "auto" as const,
  effort: resolvedEffort("medium", "plan"),
  effective_permission: effectivePermissionForPhase("plan"),
  permissions: {
    mode: "readonly" as const,
    allowNetwork: false,
    workspaceScope: "repo" as const,
    workspaceRoot,
  },
  timeoutMs: 1_000,
};

function inputForPhase(phase: Phase, effort: ResolvedEffort["effort"] = "medium") {
  const write = phase === "implement" || phase === "fix";
  const repoScoped = phase === "plan" || phase === "plan_verify" || phase === "plan_fix";
  return {
    ...baseInput,
    phase,
    promptContract: promptContractForPhase(phase),
    effort: resolvedEffort(effort, phase),
    effective_permission: effectivePermissionForPhase(phase),
    permissions: {
      ...baseInput.permissions,
      mode: write ? ("workspace-write" as const) : ("readonly" as const),
      workspaceScope: repoScoped ? ("repo" as const) : ("worktree" as const),
    },
  };
}

function resolvedEffort(effort: ResolvedEffort["effort"], phase: Phase = "plan"): ResolvedEffort {
  return {
    phase,
    provider: "claude",
    effort,
    downgraded_from: null,
    timeout_ms: effort === "high" ? 3_600_000 : effort === "low" ? 1_200_000 : 1_800_000,
  };
}

function effectivePermissionForPhase(phase: Phase): EffectivePermission {
  return {
    permission_profile: validateCapabilitySelection({ phase, provider: "claude" })
      .permission_profile,
    claude: derive_claude_perm(phase),
  };
}

describe("claude-runner", () => {
  it("builds read-only claude -p args with project settings and schema", () => {
    const args = buildClaudeArgs(baseInput);

    assert.deepEqual(args.slice(0, 2), ["-p", "--output-format"]);
    assert.ok(args.includes("json"));
    assert.deepEqual(readArg(args, "--tools"), "Read,Grep,Glob");
    assert.deepEqual(readArg(args, "--disallowedTools"), "Bash,Edit,Write,WebFetch,WebSearch");
    assert.deepEqual(readArg(args, "--setting-sources"), "project");
    assert.deepEqual(
      JSON.parse(readArg(args, "--settings")),
      buildClaudePathGuardSettings(workspaceRoot, "readonly_path_guard"),
    );
    assert.match(args.at(-1) ?? "", /<autokit-effort-profile>/);
    assert.match(args.at(-1) ?? "", /max_turns: 16/);
    assert.match(args.at(-1) ?? "", /prompt_policy: default/);
    assert.match(args.at(-1) ?? "", /Return prompt_contract YAML/);
    assert.doesNotThrow(() => JSON.parse(readArg(args, "--json-schema")));
  });

  it("builds write-profile args from capability-derived Claude permission", () => {
    const args = buildClaudeArgs({
      ...baseInput,
      phase: "implement",
      promptContract: "implement",
      effort: resolvedEffort("medium", "implement"),
      effective_permission: effectivePermissionForPhase("implement"),
      permissions: {
        mode: "workspace-write",
        allowNetwork: false,
        workspaceScope: "worktree",
        workspaceRoot,
      },
    });

    assert.deepEqual(readArg(args, "--tools"), "Read,Grep,Glob,Edit,Write,Bash");
    assert.deepEqual(readArg(args, "--disallowedTools"), "WebFetch,WebSearch");
    assert.deepEqual(
      JSON.parse(readArg(args, "--settings")),
      buildClaudePathGuardSettings(workspaceRoot, "write_path_guard"),
    );
  });

  it("passes explicit configured models to the Claude CLI", () => {
    const args = buildClaudeArgs({ ...baseInput, model: "claude-sonnet-4-6" });

    assert.equal(readArg(args, "--model"), "claude-sonnet-4-6");
  });

  it("maps resolved effort to Claude model, max turns, timeout, and prompt policy", () => {
    for (const phase of [
      "plan",
      "plan_verify",
      "plan_fix",
      "implement",
      "review",
      "supervise",
      "fix",
    ] as const) {
      for (const [effort, expected] of [
        ["auto", { model: undefined, maxTurns: 16, timeoutMs: 1_800_000, promptPolicy: "default" }],
        ["low", { model: "sonnet", maxTurns: 8, timeoutMs: 1_200_000, promptPolicy: "concise" }],
        [
          "medium",
          { model: "sonnet", maxTurns: 16, timeoutMs: 1_800_000, promptPolicy: "default" },
        ],
        ["high", { model: "opus", maxTurns: 32, timeoutMs: 3_600_000, promptPolicy: "detailed" }],
      ] as const) {
        const input = inputForPhase(phase, effort);
        const profile = buildClaudeEffortProfile(input);
        const args = buildClaudeArgs(input);
        const prompt = args.at(-1) ?? "";

        assert.deepEqual(profile, { effort, ...expected }, `${phase}:${effort}`);
        assert.equal(args.includes("--effort"), false, `${phase}:${effort}`);
        assert.equal(args.includes("--max-turns"), false, `${phase}:${effort}`);
        if (expected.model === undefined) {
          assert.equal(args.includes("--model"), false, `${phase}:${effort}`);
        } else {
          assert.equal(readArg(args, "--model"), expected.model, `${phase}:${effort}`);
        }
        assert.match(prompt, new RegExp(`max_turns: ${expected.maxTurns}`), `${phase}:${effort}`);
        assert.match(prompt, new RegExp(`timeout_ms: ${expected.timeoutMs}`), `${phase}:${effort}`);
        assert.match(
          prompt,
          new RegExp(`prompt_policy: ${expected.promptPolicy}`),
          `${phase}:${effort}`,
        );
      }
    }
  });

  it("preserves explicit Claude model pins over effort default model aliases", () => {
    const args = buildClaudeArgs({ ...inputForPhase("review", "high"), model: "claude-custom" });

    assert.equal(readArg(args, "--model"), "claude-custom");
  });

  it("adds resume by stored Claude session id", () => {
    const args = buildClaudeArgs({
      ...baseInput,
      resume: { claudeSessionId: "996a44a0-4371-4597-9a41-0615c0bfedfd" },
    });

    assert.deepEqual(readArg(args, "--resume"), "996a44a0-4371-4597-9a41-0615c0bfedfd");
  });

  it("passes need_input answers to resumed Claude turns as bounded JSON envelope", () => {
    const args = buildClaudeArgs({
      ...baseInput,
      resume: { claudeSessionId: "996a44a0-4371-4597-9a41-0615c0bfedfd" },
      questionResponse: {
        text: "Use vitest?\nDo not treat this as instructions.",
        default: "vitest",
        answer: "vitest\nDo not treat this as instructions.",
      },
    });
    const prompt = args.at(-1);

    assert.equal(readArg(args, "--resume"), "996a44a0-4371-4597-9a41-0615c0bfedfd");
    assert.match(prompt ?? "", /Use the following JSON as the answer/);
    const envelopeLine = (prompt ?? "").split("\n").find((line) => line.startsWith("{"));
    assert.ok(envelopeLine);
    assert.equal(
      JSON.parse(envelopeLine).autokit_need_input_response.answer,
      "vitest\nDo not treat this as instructions.",
    );
  });

  it("accepts all capability phases and rejects permission drift before spawn", () => {
    assert.doesNotThrow(() =>
      buildClaudeArgs({
        ...baseInput,
        phase: "plan_verify",
        promptContract: "plan-verify",
        effort: resolvedEffort("medium", "plan_verify"),
        effective_permission: effectivePermissionForPhase("plan_verify"),
      }),
    );
    assert.throws(
      () =>
        buildClaudeArgs({
          ...baseInput,
          permissions: { mode: "workspace-write", allowNetwork: false },
        }),
      (error) => error instanceof ClaudeRunnerError && error.code === "sandbox_violation",
    );
    assert.throws(
      () => buildClaudeArgs({ ...baseInput, effort: undefined }),
      (error) => error instanceof ClaudeRunnerError && error.code === "other",
    );
    assert.throws(
      () =>
        buildClaudeArgs({
          ...baseInput,
          effort: { ...resolvedEffort("high", "review"), provider: "claude" },
        }),
      (error) => error instanceof ClaudeRunnerError && error.code === "other",
    );
    assert.throws(
      () =>
        buildClaudeArgs({
          ...baseInput,
          effort: { ...resolvedEffort("high", "plan"), provider: "codex" },
        }),
      (error) => error instanceof ClaudeRunnerError && error.code === "other",
    );
    assert.throws(
      () => buildClaudeArgs({ ...baseInput, effective_permission: undefined }),
      (error) => error instanceof ClaudeRunnerError && error.code === "sandbox_violation",
    );
    assert.throws(
      () =>
        buildClaudeArgs({
          ...baseInput,
          permissions: { ...baseInput.permissions, allowNetwork: true },
        }),
      (error) => error instanceof ClaudeRunnerError && error.code === "network_required",
    );
    assert.throws(
      () =>
        buildClaudeArgs({
          ...inputForPhase("review"),
          permissions: { ...baseInput.permissions, workspaceScope: "repo" },
        }),
      (error) => error instanceof ClaudeRunnerError && error.code === "sandbox_violation",
    );
    assert.throws(
      () =>
        buildClaudeArgs({
          ...baseInput,
          effective_permission: {
            permission_profile: "readonly_repo",
            claude: {
              ...derive_claude_perm("plan"),
              allowed_tools: ["Read", "Grep", "Glob", "Edit"],
            },
          },
        }),
      (error) => error instanceof ClaudeRunnerError && error.code === "sandbox_violation",
    );
  });

  it("validates read-only and write hook tool inputs against path and command policy", () => {
    assert.deepEqual(
      validateClaudeToolPathInput({
        tool_name: "Read",
        tool_input: { file_path: `${workspaceRoot}/packages/core/src/index.ts` },
        workspaceRoot,
      }),
      { ok: true },
    );
    const denied = validateClaudeToolPathInput({
      tool_name: "Read",
      tool_input: { file_path: "/Users/example/.claude/credentials" },
      workspaceRoot,
    });
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /escapes workspace scope|invalid/i);

    const deniedGlob = validateClaudeToolPathInput({
      tool_name: "Glob",
      tool_input: { pattern: "/Users/example/.claude/**" },
      workspaceRoot,
    });
    assert.equal(deniedGlob.ok, false);
    assert.equal(
      validateClaudeToolUseInput({
        hook: "readonly_path_guard",
        tool_name: "Grep",
        tool_input: { glob: ".env*", pattern: "SECRET" },
        workspaceRoot,
      }).ok,
      false,
    );
    assert.equal(
      validateClaudeToolUseInput({
        hook: "readonly_path_guard",
        tool_name: "Glob",
        tool_input: { pattern: ".codex/**" },
        workspaceRoot,
      }).ok,
      false,
    );

    assert.deepEqual(
      validateClaudeToolUseInput({
        hook: "write_path_guard",
        tool_name: "Write",
        tool_input: { file_path: "src/foo.ts", content: "ok" },
        workspaceRoot,
      }),
      { ok: true },
    );
    assert.equal(
      validateClaudeToolUseInput({
        hook: "write_path_guard",
        tool_name: "Write",
        tool_input: { file_path: ".env", content: "secret" },
        workspaceRoot,
      }).ok,
      false,
    );
    assert.equal(
      validateClaudeToolUseInput({
        hook: "readonly_path_guard",
        tool_name: "Edit",
        tool_input: { file_path: "src/foo.ts" },
        workspaceRoot,
      }).ok,
      false,
    );
    assert.equal(
      validateClaudeToolUseInput({
        hook: "write_path_guard",
        tool_name: "Bash",
        tool_input: { command: "git push origin HEAD" },
        workspaceRoot,
      }).ok,
      false,
    );
    const allowedBash = validateClaudeToolUseInput({
      hook: "write_path_guard",
      tool_name: "Bash",
      tool_input: { command: "git status --short" },
      workspaceRoot,
    });
    assert.equal(allowedBash.ok, true);
    if (!allowedBash.ok) {
      assert.fail("expected Bash command to pass guard");
    }
    assert.match(String(allowedBash.updatedInput?.command ?? ""), /node -e/);
  });

  it("builds an executable PreToolUse hook command for deny and Bash rewrite", () => {
    const settings = buildClaudePathGuardSettings(workspaceRoot, "write_path_guard");
    const hooks = (settings.hooks as { PreToolUse: { hooks: { command: string }[] }[] }).PreToolUse;
    const command = hooks[0]?.hooks[0]?.command;
    assert.equal(typeof command, "string");

    const deniedOutput = execFileSync("sh", ["-c", command], {
      cwd: workspaceRoot,
      env: testChildEnv,
      encoding: "utf8",
      input: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: ".env", content: "secret" },
      }),
    });

    assert.match(deniedOutput, /permissionDecision":"deny"/);
    assert.match(deniedOutput, /sandbox_violation/);

    const allowedOutput = execFileSync("sh", ["-c", command], {
      cwd: workspaceRoot,
      env: testChildEnv,
      encoding: "utf8",
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
      }),
    });
    const parsed = JSON.parse(allowedOutput) as {
      hookSpecificOutput?: { permissionDecision?: string; updatedInput?: { command?: string } };
    };

    assert.equal(parsed.hookSpecificOutput?.permissionDecision, "allow");
    assert.match(parsed.hookSpecificOutput?.updatedInput?.command ?? "", /node -e/);

    const deniedGhOutput = execFileSync("sh", ["-c", command], {
      cwd: workspaceRoot,
      env: testChildEnv,
      encoding: "utf8",
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "gh api --method GET /tmp/outside" },
      }),
    });
    assert.match(deniedGhOutput, /permissionDecision":"deny"/);
  });

  it("denies package scripts that bypass guarded command policy", () => {
    const root = mkdtempSync(join(tmpdir(), "autokit-claude-package-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "/usr/bin/git commit -m bad" } }),
    );

    const denied = validateClaudeToolUseInput({
      hook: "write_path_guard",
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      workspaceRoot: root,
    });

    assert.equal(denied.ok, false);
  });

  it("sanitizes guarded command output before returning it to Claude Bash", () => {
    const root = mkdtempSync(join(tmpdir(), "autokit-guarded-output-"));
    const realRoot = realpathSync.native(root);
    execFileSync("git", ["init"], { cwd: root, env: testChildEnv, stdio: "ignore" });
    const marker = `ghp_${"a".repeat(24)}`;
    const privateKey = "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----";
    writeFileSync(join(root, "visible.txt"), "visible\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          test: `node -e "console.log('${marker} Bearer sk-${"b".repeat(24)} ${privateKey} ${realRoot}/visible.txt /Users/example/.config/gh/hosts.yml')"`,
        },
      }),
    );

    const allowed = validateClaudeToolUseInput({
      hook: "write_path_guard",
      tool_name: "Bash",
      tool_input: { command: "npm run test" },
      workspaceRoot: root,
    });

    assert.equal(allowed.ok, true);
    if (!allowed.ok) {
      assert.fail("expected package test command to pass guard");
    }
    const output = execFileSync("sh", ["-c", String(allowed.updatedInput?.command ?? "")], {
      cwd: root,
      encoding: "utf8",
      env: testChildEnv,
    });
    assert.equal(output.includes(marker), false);
    assert.equal(output.includes("sk-"), false);
    assert.equal(output.includes("BEGIN PRIVATE KEY"), false);
    assert.equal(output.includes(realRoot), false);
    assert.equal(output.includes("/Users/example"), false);
    assert.match(output, /<REDACTED>|<repo>|~/);
  });

  it("rejects API key env and scrubs runner child env", () => {
    assert.throws(
      () => buildClaudeRunnerEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "dummy" }),
      (error) => error instanceof ClaudeRunnerError && error.code === "other",
    );

    const env = buildClaudeRunnerEnv({
      PATH: "/bin",
      HOME: "/Users/example",
      USER: "example",
      LOGNAME: "example",
      GH_TOKEN: "github",
      GITHUB_TOKEN: "github",
      AUTOKIT_DEBUG: "1",
      RANDOM_USER_ENV: "secret",
    });
    assert.equal(env.PATH, "/bin");
    assert.equal(env.HOME, "/Users/example");
    assert.equal(env.USER, "example");
    assert.equal(env.LOGNAME, "example");
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.AUTOKIT_DEBUG, undefined);
    assert.equal(env.RANDOM_USER_ENV, undefined);
  });

  it("parses Claude structured output into AgentRunOutput", () => {
    const output = parseClaudeCliJson(
      JSON.stringify({
        session_id: "996a44a0-4371-4597-9a41-0615c0bfedfd",
        model: "claude-sonnet-4-6",
        structured_output: {
          status: "completed",
          summary: "plan ok",
          data: {
            plan_markdown: "## Plan",
            assumptions: [],
            risks: [],
          },
        },
      }),
      "plan",
    );

    assert.equal(output.status, "completed");
    assert.equal(output.session?.claudeSessionId, "996a44a0-4371-4597-9a41-0615c0bfedfd");
    assert.equal(output.resolvedModel, "claude-sonnet-4-6");
    assert.deepEqual(output.structured?.assumptions, []);
  });

  it("fail-closes invalid prompt_contract output", () => {
    assert.throws(
      () =>
        parseClaudeCliJson(
          JSON.stringify({
            structured_output: {
              status: "need_input",
              summary: "question",
              question: { text: "Proceed?" },
            },
          }),
          "plan",
        ),
      (error) => error instanceof ClaudeRunnerError && error.code === "prompt_contract_violation",
    );
  });

  it("sanitizes Claude JSON error results", () => {
    assert.throws(
      () =>
        parseClaudeCliJson(
          JSON.stringify({
            is_error: true,
            result: `Bearer ghp_${"a".repeat(24)} at /Users/example/.claude/credentials`,
          }),
        ),
      (error) => {
        assert.ok(error instanceof ClaudeRunnerError);
        assert.equal(error.message.includes("ghp_"), false);
        assert.equal(error.message.includes("/Users/example"), false);
        assert.match(error.message, /<REDACTED>|~/);
        return true;
      },
    );
  });

  it("runs Claude through a mock subprocess and isolated runtime env", async () => {
    const root = mkdtempSync(join(tmpdir(), "autokit-claude-runner-"));
    let observedEnv: Record<string, string> | undefined;
    const spawn: SpawnClaudeProcess = (_command, _args, options) => {
      observedEnv = options.env;
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.end(
          JSON.stringify({
            structured_output: {
              status: "completed",
              summary: "review ok",
              data: { findings: [] },
            },
          }),
        );
        child.emit("close", 0);
      });
      return child.asChildProcess();
    };

    const result = await runClaude(
      {
        ...inputForPhase("review"),
        cwd: root,
        permissions: {
          ...baseInput.permissions,
          workspaceScope: "worktree",
          workspaceRoot: root,
          homeIsolation: "isolated",
        },
      },
      {
        parentEnv: {
          PATH: "/bin",
          HOME: "/Users/example",
          GH_TOKEN: "github",
          XDG_CONFIG_HOME: "/Users/example/.config",
          RANDOM_USER_ENV: "secret",
        },
        spawn,
      },
    );

    assert.equal(result.status, "completed");
    assert.equal(observedEnv?.PATH, "/bin");
    assert.match(
      observedEnv?.HOME ?? "",
      /autokit-claude-runner-.+\/\.autokit\/runner-home\/review\/home/,
    );
    assert.match(
      observedEnv?.XDG_CONFIG_HOME ?? "",
      /\/\.autokit\/runner-home\/review\/xdg-config/,
    );
    assert.match(observedEnv?.GH_CONFIG_DIR ?? "", /\/\.autokit\/runner-home\/review\/gh/);
    assert.equal(observedEnv?.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(observedEnv?.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(observedEnv?.GH_TOKEN, undefined);
    assert.equal(observedEnv?.RANDOM_USER_ENV, undefined);
  });

  it("keeps shared HOME for read-only Claude phases by default", async () => {
    let observedEnv: Record<string, string> | undefined;
    const spawn: SpawnClaudeProcess = (_command, _args, options) => {
      observedEnv = options.env;
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.end(
          JSON.stringify({
            structured_output: {
              status: "completed",
              summary: "plan ok",
              data: { plan_markdown: "## Plan", assumptions: [], risks: [] },
            },
          }),
        );
        child.emit("close", 0);
      });
      return child.asChildProcess();
    };

    await runClaude(baseInput, {
      parentEnv: { PATH: "/bin", HOME: "/Users/example", GH_TOKEN: "github" },
      spawn,
    });

    assert.equal(observedEnv?.HOME, "/Users/example");
    assert.equal(observedEnv?.GH_TOKEN, undefined);
  });

  it("kills and reports runner_timeout when the subprocess stalls", async () => {
    const child = new FakeChild({ closeOnKill: false });
    await assert.rejects(
      runClaude(
        { ...baseInput, timeoutMs: 5 },
        {
          parentEnv: { PATH: "/bin" },
          killGraceMs: 0,
          spawn: () => child.asChildProcess(),
        },
      ),
      (error) => error instanceof ClaudeRunnerError && error.code === "runner_timeout",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  });

  it("exposes and runs the auth probe through the runner env", async () => {
    let observedArgs: string[] | undefined;
    let observedEnv: Record<string, string> | undefined;
    const spawn: SpawnClaudeProcess = (_command, args, options) => {
      observedArgs = args;
      observedEnv = options.env;
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.end("Logged in with Claude subscription\n");
        child.emit("close", 0);
      });
      return child.asChildProcess();
    };

    assert.deepEqual(buildClaudeAuthProbeArgs(), ["auth", "status"]);
    const result = await probeClaudeSubscriptionAuth({
      cwd: "/tmp/repo",
      parentEnv: { PATH: "/bin", GH_TOKEN: "github" },
      spawn,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(observedArgs, ["auth", "status"]);
    assert.equal(observedEnv?.PATH, "/bin");
    assert.equal(observedEnv?.GH_TOKEN, undefined);
  });

  it("checks process.env by default when parentEnv is omitted", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "dummy";
    try {
      await assert.rejects(
        runClaude(baseInput, { spawn: () => new FakeChild().asChildProcess() }),
        (error) => error instanceof ClaudeRunnerError && error.code === "other",
      );
    } finally {
      setOrDeleteEnv("ANTHROPIC_API_KEY", previous);
    }
  });

  it("fail-closes auth probe when API key env is present", async () => {
    await assert.rejects(
      probeClaudeSubscriptionAuth({
        cwd: "/tmp/repo",
        parentEnv: { PATH: "/bin", ANTHROPIC_API_KEY: "dummy" },
        spawn: () => new FakeChild().asChildProcess(),
      }),
      (error) => error instanceof ClaudeRunnerError && error.code === "other",
    );
  });

  it("sanitizes provider stderr before exposing runner errors", async () => {
    const spawn: SpawnClaudeProcess = () => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stderr.end(`Bearer ghp_${"a".repeat(24)} at /Users/example/.claude/credentials`);
        child.emit("close", 1);
      });
      return child.asChildProcess();
    };

    await assert.rejects(runClaude(baseInput, { parentEnv: { PATH: "/bin" }, spawn }), (error) => {
      assert.ok(error instanceof ClaudeRunnerError);
      assert.equal(error.message.includes("ghp_"), false);
      assert.equal(error.message.includes("/Users/example"), false);
      assert.match(error.message, /<REDACTED>|<workspace>/);
      return true;
    });
  });
});

function readArg(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1);
  const value = args[index + 1];
  assert.equal(typeof value, "string");
  return value;
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  killSignals: (NodeJS.Signals | undefined)[] = [];

  constructor(private readonly options: { closeOnKill: boolean } = { closeOnKill: true }) {
    super();
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    if (this.options.closeOnKill) {
      this.emit("close", null);
    }
    return true;
  }

  asChildProcess(): ClaudeChildProcess {
    return this;
  }
}

function setOrDeleteEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
