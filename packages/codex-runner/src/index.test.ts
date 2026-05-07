import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  capabilityPhases,
  type Phase,
  promptContractForPhase,
  type ResolvedEffort,
} from "@cattyneo/autokit-core";

import {
  buildCodexArgs,
  buildCodexAuthProbeArgs,
  buildCodexRunnerEnv,
  type CodexChildProcess,
  CodexRunnerError,
  codexPromptContractJsonSchema,
  parseCodexFinalOutput,
  parseCodexJsonl,
  probeCodexChatGptAuth,
  runCodex,
  type SpawnCodexProcess,
} from "./index.ts";

const workspaceRoot = realpathSync.native(process.cwd());
const baseInput = {
  provider: "codex" as const,
  phase: "implement" as const,
  cwd: workspaceRoot,
  prompt: "Return prompt_contract JSON",
  promptContract: "implement" as const,
  model: "auto" as const,
  permissions: {
    mode: "workspace-write" as const,
    allowNetwork: false,
    workspaceScope: "worktree" as const,
    workspaceRoot,
  },
  timeoutMs: 1_000,
};

const runFiles = {
  schemaFile: "/tmp/autokit-schema.json",
  outputFile: "/tmp/autokit-output.json",
  cleanup: () => {},
};

function inputForPhase(phase: Phase) {
  const write = phase === "implement" || phase === "fix";
  const repoScoped = phase === "plan" || phase === "plan_verify" || phase === "plan_fix";
  return {
    ...baseInput,
    phase,
    promptContract: promptContractForPhase(phase),
    permissions: {
      ...baseInput.permissions,
      mode: write ? ("workspace-write" as const) : ("readonly" as const),
      workspaceScope: repoScoped ? ("repo" as const) : ("worktree" as const),
    },
    effort: resolvedEffort("auto", phase),
  };
}

function resolvedEffort(
  effort: ResolvedEffort["effort"],
  phase: Phase = "implement",
): ResolvedEffort {
  return {
    phase,
    provider: "codex",
    effort,
    downgraded_from: null,
    timeout_ms: effort === "high" ? 3_600_000 : effort === "low" ? 1_200_000 : 1_800_000,
  };
}

function completedDataForPhase(phase: Phase): Record<string, unknown> {
  switch (phase) {
    case "plan":
      return { plan_markdown: "## Plan", assumptions: [], risks: [] };
    case "plan_verify":
      return { result: "ok", findings: [] };
    case "plan_fix":
      return { plan_markdown: "## Fixed Plan", addressed_findings: [] };
    case "implement":
      return {
        changed_files: ["src/a.ts"],
        tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
        docs_updated: false,
        notes: "done",
      };
    case "review":
      return { findings: [] };
    case "supervise":
      return {
        accept_ids: [],
        reject_ids: [],
        reject_reasons: {},
        fix_prompt: "Fix the accepted findings.",
      };
    case "fix":
      return {
        changed_files: ["src/a.ts"],
        tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
        resolved_accept_ids: [],
        unresolved_accept_ids: [],
        notes: "done",
      };
  }
}

describe("codex-runner", () => {
  it("builds codex exec args for workspace-write phases with schema and output file", () => {
    const args = buildCodexArgs(baseInput, runFiles);

    assert.deepEqual(args.slice(0, 4), ["-a", "never", "--sandbox", "workspace-write"]);
    assert.equal(args.includes("exec"), true);
    assert.equal(readArg(args, "-c"), "model_reasoning_effort=medium");
    assert.equal(readArg(args, "--sandbox"), "workspace-write");
    assert.equal(readArg(args, "--output-schema"), runFiles.schemaFile);
    assert.equal(readArg(args, "-o"), runFiles.outputFile);
    assert.ok(args.includes("--json"));
    assert.ok(args.includes("--ignore-user-config"));
    assert.ok(args.includes("--ignore-rules"));
    assert.equal(args.at(-1), "-");
  });

  it("builds read-only plan_verify args and forwards explicit models", () => {
    const args = buildCodexArgs(
      {
        ...baseInput,
        phase: "plan_verify",
        promptContract: "plan-verify",
        model: "gpt-5.5",
        permissions: { ...baseInput.permissions, mode: "readonly", workspaceScope: "repo" },
      },
      runFiles,
    );

    assert.equal(readArg(args, "--sandbox"), "read-only");
    assert.equal(readArg(args, "--model"), "gpt-5.5");
    assert.equal(readArg(args, "--disable"), "shell_tool");
  });

  it("accepts all capability phases with phase-derived sandbox", () => {
    for (const phase of capabilityPhases) {
      const args = buildCodexArgs(inputForPhase(phase), runFiles);
      const expectedSandbox =
        phase === "implement" || phase === "fix" ? "workspace-write" : "read-only";

      assert.equal(readArg(args, "--sandbox"), expectedSandbox, phase);
      assert.equal(args.includes("--reasoning-effort"), false);
      assert.equal(readArg(args, "-c"), "model_reasoning_effort=medium");
      if (expectedSandbox === "read-only") {
        assert.equal(readArg(args, "--disable"), "shell_tool");
      } else {
        assert.equal(args.includes("--disable"), false);
      }
    }
  });

  it("maps resolved effort to Codex model_reasoning_effort config", () => {
    for (const [effort, expected] of [
      ["auto", "medium"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
    ] as const) {
      const args = buildCodexArgs(
        {
          ...baseInput,
          effort: resolvedEffort(effort),
        },
        runFiles,
      );

      assert.equal(readArg(args, "-c"), `model_reasoning_effort=${expected}`);
      assert.equal(args.includes("--reasoning-effort"), false);
    }
  });

  it("keeps shell access available for workspace-write Codex phases", () => {
    const args = buildCodexArgs(baseInput, runFiles);

    assert.equal(args.includes("--disable"), false);
    assert.equal(args.includes("shell_tool"), false);
  });

  it("uses stored codex session id for resume and never uses --last", () => {
    const args = buildCodexArgs(
      {
        ...baseInput,
        resume: { codexSessionId: "019df4ff-9c29-7d71-8321-9217c46e6d72" },
      },
      runFiles,
    );

    assert.equal(args.includes("exec"), true);
    assert.equal(args.includes("resume"), true);
    assert.equal(args.includes("019df4ff-9c29-7d71-8321-9217c46e6d72"), true);
    assert.equal(args.includes("--last"), false);
    assert.equal(args.includes("--output-schema"), false);
  });

  it("rejects non-Codex provider, wrong sandbox mode, network, and workspace scope", () => {
    assert.throws(
      () => buildCodexArgs({ ...baseInput, provider: "claude" }, runFiles),
      (error) => error instanceof CodexRunnerError && error.code === "other",
    );
    assert.throws(
      () =>
        buildCodexArgs(
          {
            ...baseInput,
            phase: "plan_verify",
            promptContract: "plan-verify",
            permissions: {
              ...baseInput.permissions,
              mode: "workspace-write",
              workspaceScope: "repo",
            },
          },
          runFiles,
        ),
      (error) => error instanceof CodexRunnerError && error.code === "sandbox_violation",
    );
    assert.throws(
      () =>
        buildCodexArgs(
          { ...baseInput, permissions: { ...baseInput.permissions, allowNetwork: true } },
          runFiles,
        ),
      (error) => error instanceof CodexRunnerError && error.code === "network_required",
    );
    assert.throws(
      () =>
        buildCodexArgs(
          { ...baseInput, permissions: { ...baseInput.permissions, workspaceScope: "repo" } },
          runFiles,
        ),
      (error) => error instanceof CodexRunnerError && error.code === "sandbox_violation",
    );
  });

  it("rejects API key env and scrubs runner child env", () => {
    assert.throws(
      () => buildCodexRunnerEnv({ PATH: "/bin", OPENAI_API_KEY: "dummy" }),
      (error) => error instanceof CodexRunnerError && error.code === "other",
    );

    const env = buildCodexRunnerEnv({
      PATH: "/bin",
      HOME: "/Users/example",
      USER: "example",
      LOGNAME: "example",
      CODEX_API_KEY: undefined,
      GH_TOKEN: "github",
      RANDOM_USER_ENV: "secret",
    });
    assert.equal(env.PATH, "/bin");
    assert.equal(env.HOME, "/Users/example");
    assert.equal(env.USER, "example");
    assert.equal(env.LOGNAME, "example");
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.RANDOM_USER_ENV, undefined);
  });

  it("parses JSONL thread_id and fail-closes event shape drift", () => {
    assert.deepEqual(
      parseCodexJsonl(
        [
          JSON.stringify({
            thread_id: "019df4ff-9c29-7d71-8321-9217c46e6d72",
            type: "thread.started",
          }),
          JSON.stringify({
            thread_id: "019df4ff-9c29-7d71-8321-9217c46e6d72",
            type: "item.started",
            item: { type: "command_execution" },
          }),
          JSON.stringify({
            thread_id: "019df4ff-9c29-7d71-8321-9217c46e6d72",
            type: "item.completed",
            item: { type: "agent_message" },
          }),
          JSON.stringify({
            thread_id: "019df4ff-9c29-7d71-8321-9217c46e6d72",
            type: "item.started",
            item: {
              type: "file_change",
              changes: [{ path: "src/pagination.ts", kind: "update" }],
              status: "in_progress",
            },
          }),
          JSON.stringify({
            thread_id: "019df4ff-9c29-7d71-8321-9217c46e6d72",
            type: "item.completed",
            item: {
              type: "file_change",
              changes: [{ path: "src/pagination.ts", kind: "update" }],
              status: "completed",
            },
          }),
        ].join("\n"),
      ),
      { codexSessionId: "019df4ff-9c29-7d71-8321-9217c46e6d72" },
    );
    assert.throws(
      () => parseCodexJsonl(JSON.stringify({ unexpected: true })),
      (error) => error instanceof CodexRunnerError && error.code === "prompt_contract_violation",
    );
    assert.throws(
      () => parseCodexJsonl(JSON.stringify({ type: "approval_request" })),
      (error) => error instanceof CodexRunnerError && error.code === "sandbox_violation",
    );
    assert.throws(
      () =>
        parseCodexJsonl(
          JSON.stringify({
            thread_id: "019df4ff-9c29-7d71-8321-9217c46e6d72",
            type: "future.event",
          }),
        ),
      (error) => error instanceof CodexRunnerError && error.code === "prompt_contract_violation",
    );
  });

  it("validates final prompt_contract JSON from output-last-message", () => {
    const payload = parseCodexFinalOutput(
      JSON.stringify({
        status: "completed",
        summary: "implemented",
        question: null,
        data: {
          changed_files: ["packages/codex-runner/src/index.ts"],
          tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
          docs_updated: false,
          notes: "done",
        },
      }),
      "implement",
    );

    assert.equal(payload.status, "completed");
    assert.equal(payload.summary, "implemented");
    assert.throws(
      () =>
        parseCodexFinalOutput(
          JSON.stringify({
            status: "need_input",
            summary: "question",
            question: { text: "Proceed?" },
          }),
          "implement",
        ),
      (error) => error instanceof CodexRunnerError && error.code === "prompt_contract_violation",
    );
  });

  it("validates final payloads for every prompt contract and fails schema violations", () => {
    for (const phase of capabilityPhases) {
      const contract = promptContractForPhase(phase);
      const payload = parseCodexFinalOutput(
        JSON.stringify({
          status: "completed",
          summary: `${phase} ok`,
          data: completedDataForPhase(phase),
          question: null,
        }),
        contract,
      );

      assert.equal(payload.status, "completed", phase);
      assert.deepEqual(payload.data, completedDataForPhase(phase));
    }

    assert.throws(
      () =>
        parseCodexFinalOutput(
          JSON.stringify({
            status: "completed",
            summary: "bad",
            data: null,
            question: null,
          }),
          "implement",
        ),
      (error) => error instanceof CodexRunnerError && error.code === "prompt_contract_violation",
    );
  });

  it("keeps the Codex prompt schema strict surface stable", () => {
    const schema = codexPromptContractJsonSchema("plan-verify") as {
      required: string[];
      additionalProperties: boolean;
      properties: { data: { anyOf: unknown[] }; question: { anyOf: unknown[] } };
    };

    assert.deepEqual(schema.required, ["status", "summary", "data", "question"]);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.data.anyOf.at(-1), { type: "null" });
    assert.deepEqual(schema.properties.question.anyOf.at(-1), { type: "null" });
    const planVerifyDataSchema = schema.properties.data.anyOf[0] as { anyOf: unknown[] };
    assert.equal(planVerifyDataSchema.anyOf.length, 2);
  });

  it("emits a plan_verify output schema that keeps ok findings empty", async () => {
    let observedSchema: Record<string, unknown> | undefined;
    let outputText = "";
    const spawn: SpawnCodexProcess = (_command, args) => {
      const child = new FakeChild();
      queueMicrotask(() => {
        if (args.join(" ") === "login status") {
          child.stdout.end("Logged in with ChatGPT\n");
          child.emit("close", 0);
          return;
        }
        outputText = JSON.stringify({
          status: "completed",
          summary: "verified",
          data: { result: "ok", findings: [] },
          question: null,
        });
        child.stdout.end(
          JSON.stringify({
            thread_id: "019df4ff-9c29-7d71-8321-9217c46e6d72",
            type: "turn.completed",
          }),
        );
        child.emit("close", 0);
      });
      return child.asChildProcess();
    };

    await runCodex(
      {
        ...baseInput,
        phase: "plan_verify",
        promptContract: "plan-verify",
        permissions: { ...baseInput.permissions, mode: "readonly", workspaceScope: "repo" },
      },
      {
        parentEnv: { PATH: "/bin" },
        spawn,
        createRunFiles: (_contract, schema) => {
          observedSchema = schema;
          return { ...runFiles, cleanup: () => {} };
        },
        readOutputFile: () => outputText,
      },
    );

    assert.ok(observedSchema);
    const dataSchema = (observedSchema.properties as Record<string, unknown> | undefined)?.data as
      | { anyOf?: unknown }
      | undefined;
    assert.ok(Array.isArray(dataSchema?.anyOf));

    const planVerifySchema = dataSchema.anyOf[0] as { anyOf?: unknown };
    assert.ok(Array.isArray(planVerifySchema.anyOf));

    const branches = planVerifySchema.anyOf;
    const branchFor = (result: "ok" | "ng") =>
      branches.find((branch) => {
        if (branch === null || typeof branch !== "object") {
          return false;
        }
        const properties = (branch as { properties?: Record<string, unknown> }).properties;
        const resultSchema = properties?.result;
        return (
          resultSchema !== null &&
          typeof resultSchema === "object" &&
          Array.isArray((resultSchema as { enum?: unknown }).enum) &&
          (resultSchema as { enum: unknown[] }).enum.length === 1 &&
          (resultSchema as { enum: unknown[] }).enum[0] === result
        );
      }) as { properties?: Record<string, unknown> } | undefined;

    const okBranch = branchFor("ok");
    const ngBranch = branchFor("ng");
    assert.ok(okBranch);
    assert.ok(ngBranch);

    const okFindings = okBranch.properties?.findings as { maxItems?: unknown } | undefined;
    const ngFindings = ngBranch.properties?.findings as { maxItems?: unknown } | undefined;
    assert.equal(okFindings?.maxItems, 0);
    assert.equal(ngFindings?.maxItems, 20);
  });

  it("runs Codex through a mock subprocess, reads final output, and returns session id", async () => {
    let observedArgs: string[] | undefined;
    let observedEnv: Record<string, string> | undefined;
    const calls: string[][] = [];
    let outputText = "";
    const spawn: SpawnCodexProcess = (_command, args, options) => {
      calls.push(args);
      observedArgs = args;
      observedEnv = options.env;
      const child = new FakeChild();
      queueMicrotask(() => {
        if (args.join(" ") === "login status") {
          child.stdout.end("Logged in with ChatGPT\n");
          child.emit("close", 0);
          return;
        }
        outputText = JSON.stringify({
          status: "completed",
          summary: "fix ok",
          data: {
            changed_files: ["src/a.ts"],
            tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
            resolved_accept_ids: [],
            unresolved_accept_ids: [],
            notes: "fixed",
          },
        });
        child.stdout.end(
          JSON.stringify({
            thread_id: "019df4ff-9c29-7d71-8321-9217c46e6d72",
            type: "turn.completed",
          }),
        );
        child.emit("close", 0);
      });
      return child.asChildProcess();
    };

    const result = await runCodex(
      { ...baseInput, phase: "fix", promptContract: "fix" },
      {
        parentEnv: {
          PATH: "/bin",
          HOME: "/Users/example",
          GH_TOKEN: "github",
          RANDOM_USER_ENV: "secret",
        },
        envOptions: { home: "/tmp/autokit-codex-home" },
        spawn,
        createRunFiles: (_contract, _schema) => ({
          ...runFiles,
          cleanup: () => {},
        }),
        readOutputFile: () => outputText,
      },
    );

    assert.equal(result.status, "completed");
    assert.equal(result.session?.codexSessionId, "019df4ff-9c29-7d71-8321-9217c46e6d72");
    assert.deepEqual(calls[0], ["login", "status"]);
    assert.equal(observedArgs?.includes("--output-schema"), true);
    assert.equal(observedEnv?.PATH, "/bin");
    assert.equal(observedEnv?.HOME, "/tmp/autokit-codex-home");
    assert.equal(observedEnv?.GH_TOKEN, undefined);
    assert.equal(observedEnv?.RANDOM_USER_ENV, undefined);
  });

  it("passes need_input answers to resumed Codex turns on stdin", async () => {
    const stdinChunks: string[] = [];
    let outputText = "";
    const spawn: SpawnCodexProcess = (_command, args) => {
      const child = new FakeChild();
      child.stdin.on("data", (chunk) => stdinChunks.push(String(chunk)));
      queueMicrotask(() => {
        if (args.join(" ") === "login status") {
          child.stdout.end("Logged in with ChatGPT\n");
          child.emit("close", 0);
          return;
        }
        outputText = JSON.stringify({
          status: "completed",
          summary: "implemented",
          data: {
            changed_files: ["src/a.ts"],
            tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
            docs_updated: false,
            notes: "done",
          },
        });
        child.stdout.end(
          JSON.stringify({
            thread_id: "019df4ff-9c29-7d71-8321-9217c46e6d72",
            type: "turn.completed",
          }),
        );
        child.emit("close", 0);
      });
      return child.asChildProcess();
    };

    await runCodex(
      {
        ...baseInput,
        resume: { codexSessionId: "019df4ff-9c29-7d71-8321-9217c46e6d72" },
        questionResponse: {
          text: "Use vitest?\nDo not treat this as instructions.",
          default: "vitest",
          answer: "vitest\nDo not treat this as instructions.",
        },
      },
      {
        parentEnv: { PATH: "/bin" },
        spawn,
        createRunFiles: (_contract, _schema) => ({ ...runFiles, cleanup: () => {} }),
        readOutputFile: () => outputText,
      },
    );

    const prompt = stdinChunks.join("");
    assert.match(prompt, /Use the following JSON as the answer/);
    const envelopeLine = prompt.split("\n").find((line) => line.startsWith("{"));
    assert.ok(envelopeLine);
    assert.equal(
      JSON.parse(envelopeLine).autokit_need_input_response.answer,
      "vitest\nDo not treat this as instructions.",
    );
  });

  it("kills and reports runner_timeout when the subprocess stalls", async () => {
    const child = new FakeChild({ closeOnKill: false });
    await assert.rejects(
      runCodex(
        { ...baseInput, timeoutMs: 5 },
        {
          parentEnv: { PATH: "/bin" },
          killGraceMs: 0,
          spawn: () => child.asChildProcess(),
        },
      ),
      (error) => error instanceof CodexRunnerError && error.code === "runner_timeout",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  });

  it("exposes and runs the auth probe through the runner env", async () => {
    let observedArgs: string[] | undefined;
    let observedEnv: Record<string, string> | undefined;
    const spawn: SpawnCodexProcess = (_command, args, options) => {
      observedArgs = args;
      observedEnv = options.env;
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.end("Logged in with ChatGPT\n");
        child.emit("close", 0);
      });
      return child.asChildProcess();
    };

    assert.deepEqual(buildCodexAuthProbeArgs(), ["login", "status"]);
    const result = await probeCodexChatGptAuth({
      cwd: "/tmp/repo",
      parentEnv: { PATH: "/bin", GH_TOKEN: "github" },
      spawn,
    });
    assert.equal(result.ok, true);
    assert.equal(result.authMode, "chatgpt");
    assert.deepEqual(observedArgs, ["login", "status"]);
    assert.equal(observedEnv?.PATH, "/bin");
    assert.equal(observedEnv?.GH_TOKEN, undefined);
  });

  it("checks process.env by default and fail-closes unknown auth mode", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "dummy";
    try {
      await assert.rejects(
        runCodex(baseInput, { spawn: () => new FakeChild().asChildProcess() }),
        (error) => error instanceof CodexRunnerError && error.code === "other",
      );
    } finally {
      setOrDeleteEnv("OPENAI_API_KEY", previous);
    }

    await assert.rejects(
      probeCodexChatGptAuth({
        cwd: "/tmp/repo",
        parentEnv: { PATH: "/bin" },
        spawn: () => {
          const child = new FakeChild();
          queueMicrotask(() => {
            child.stdout.end("Logged in\n");
            child.emit("close", 0);
          });
          return child.asChildProcess();
        },
      }),
      (error) => error instanceof CodexRunnerError && error.code === "other",
    );

    await assert.rejects(
      runCodex(baseInput, {
        parentEnv: { PATH: "/bin" },
        spawn: () => {
          const child = new FakeChild();
          queueMicrotask(() => {
            child.stdout.end("Logged in\n");
            child.emit("close", 0);
          });
          return child.asChildProcess();
        },
      }),
      (error) => error instanceof CodexRunnerError && error.code === "other",
    );
  });

  it("sanitizes provider stderr before exposing runner errors", async () => {
    const spawn: SpawnCodexProcess = (_command, args) => {
      const child = new FakeChild();
      queueMicrotask(() => {
        if (args.join(" ") === "login status") {
          child.stdout.end("Logged in with ChatGPT\n");
          child.emit("close", 0);
          return;
        }
        child.stderr.end(
          `Bearer sk-${"a".repeat(24)} access_token="secret" refresh_token="secret" AKIA${"A".repeat(16)} at /Users/example/.codex/auth.json`,
        );
        child.emit("close", 1);
      });
      return child.asChildProcess();
    };

    await assert.rejects(runCodex(baseInput, { parentEnv: { PATH: "/bin" }, spawn }), (error) => {
      assert.ok(error instanceof CodexRunnerError);
      assert.equal(error.message.includes("sk-"), false);
      assert.equal(error.message.includes('access_token="secret"'), false);
      assert.equal(error.message.includes('refresh_token="secret"'), false);
      assert.equal(error.message.includes("AKIA"), false);
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
  stdin = new PassThrough();
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

  asChildProcess(): CodexChildProcess {
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
