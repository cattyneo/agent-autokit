import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  buildClaudeArgs,
  buildClaudeAuthProbeArgs,
  buildClaudePathGuardSettings,
  buildClaudeRunnerEnv,
  type ClaudeChildProcess,
  ClaudeRunnerError,
  parseClaudeCliJson,
  probeClaudeSubscriptionAuth,
  runClaude,
  type SpawnClaudeProcess,
  validateClaudeToolPathInput,
} from "./index.ts";

const workspaceRoot = realpathSync.native(process.cwd());
const baseInput = {
  provider: "claude" as const,
  phase: "plan" as const,
  cwd: workspaceRoot,
  prompt: "Return prompt_contract YAML",
  promptContract: "plan" as const,
  model: "auto" as const,
  permissions: {
    mode: "readonly" as const,
    allowNetwork: false,
    workspaceScope: "repo" as const,
    workspaceRoot,
  },
  timeoutMs: 1_000,
};

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
      buildClaudePathGuardSettings(workspaceRoot),
    );
    assert.equal(args.at(-1), baseInput.prompt);
    assert.doesNotThrow(() => JSON.parse(readArg(args, "--json-schema")));
  });

  it("passes explicit configured models to the Claude CLI", () => {
    const args = buildClaudeArgs({ ...baseInput, model: "claude-sonnet-4-6" });

    assert.equal(readArg(args, "--model"), "claude-sonnet-4-6");
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

  it("rejects non-Claude phases and non-readonly permissions before spawn", () => {
    assert.throws(
      () => buildClaudeArgs({ ...baseInput, phase: "implement", promptContract: "implement" }),
      (error) => error instanceof ClaudeRunnerError && error.code === "other",
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
          ...baseInput,
          phase: "review",
          promptContract: "review",
          permissions: { ...baseInput.permissions, workspaceScope: "repo" },
        }),
      (error) => error instanceof ClaudeRunnerError && error.code === "sandbox_violation",
    );
  });

  it("validates Read/Grep/Glob tool paths against the workspace root", () => {
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

  it("runs Claude through a mock subprocess and buildRunnerEnv", async () => {
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
        ...baseInput,
        phase: "review",
        promptContract: "review",
        permissions: { ...baseInput.permissions, workspaceScope: "worktree" },
      },
      {
        parentEnv: { PATH: "/bin", GH_TOKEN: "github", RANDOM_USER_ENV: "secret" },
        spawn,
      },
    );

    assert.equal(result.status, "completed");
    assert.equal(observedEnv?.PATH, "/bin");
    assert.equal(observedEnv?.GH_TOKEN, undefined);
    assert.equal(observedEnv?.RANDOM_USER_ENV, undefined);
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
