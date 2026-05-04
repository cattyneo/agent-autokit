import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildRunnerEnv } from "../../packages/core/src/env-allowlist.ts";
import { validatePromptContract } from "./spike-runner-stability.ts";

type Contract = "plan" | "plan-verify" | "plan-fix" | "implement" | "review" | "supervise" | "fix";

type Provider = "claude" | "codex";

type PhaseSpec = {
  provider: Provider;
  phase: string;
  contract: Contract;
  attempts: number;
  resumeAttempts: number;
  sandbox?: "read-only" | "workspace-write";
};

type AttemptResult = {
  provider: Provider;
  phase: string;
  contract: Contract;
  kind: "attempt" | "resume" | "sandbox";
  index: number;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  sessionId?: string;
  threadId?: string;
  validationErrors: string[];
  error?: string;
  costUsd?: number;
};

type MatrixArtifact = {
  generatedAt: string;
  env: {
    apiKeysUnset: boolean;
    claudeVersion?: string;
    codexVersion?: string;
  };
  specs: PhaseSpec[];
  results: AttemptResult[];
  summary: Record<string, unknown>;
};

const API_KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"] as const;
const CLAUDE_PHASES: PhaseSpec[] = [
  { provider: "claude", phase: "plan", contract: "plan", attempts: 20, resumeAttempts: 1 },
  { provider: "claude", phase: "plan_fix", contract: "plan-fix", attempts: 20, resumeAttempts: 1 },
  { provider: "claude", phase: "review", contract: "review", attempts: 20, resumeAttempts: 1 },
  {
    provider: "claude",
    phase: "supervise",
    contract: "supervise",
    attempts: 20,
    resumeAttempts: 1,
  },
];
const CODEX_PHASES: PhaseSpec[] = [
  {
    provider: "codex",
    phase: "plan_verify",
    contract: "plan-verify",
    attempts: 20,
    resumeAttempts: 3,
    sandbox: "read-only",
  },
  {
    provider: "codex",
    phase: "implement",
    contract: "implement",
    attempts: 20,
    resumeAttempts: 1,
    sandbox: "workspace-write",
  },
  {
    provider: "codex",
    phase: "fix",
    contract: "fix",
    attempts: 20,
    resumeAttempts: 1,
    sandbox: "workspace-write",
  },
];

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    printHelp();
    return 0;
  }
  if (!args.includes("--allow-model-calls")) {
    process.stderr.write("--allow-model-calls is required for #23 live matrix execution.\n");
    return 2;
  }

  assertApiKeysUnset();

  const provider = readProvider(args);
  if (provider === undefined) {
    process.stderr.write("--provider must be claude, codex, or all.\n");
    return 2;
  }
  const specs =
    provider === "claude"
      ? CLAUDE_PHASES
      : provider === "codex"
        ? CODEX_PHASES
        : [...CLAUDE_PHASES, ...CODEX_PHASES];
  const outDir = resolve(readOption(args, "--out-dir") ?? ".reports/issue-23-runner-adoption");
  await mkdir(outDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const results: AttemptResult[] = [];
  let stopAll = false;
  for (const spec of specs) {
    const firstSuccessfulIds: string[] = [];
    for (let index = 1; index <= spec.attempts; index += 1) {
      const result = await runPhaseAttempt(spec, "attempt", index);
      results.push(result);
      process.stdout.write(formatProgress(result));
      if (result.ok && (result.sessionId || result.threadId)) {
        firstSuccessfulIds.push(result.sessionId ?? result.threadId ?? "");
      }
      if (shouldStopEarly(results, spec)) {
        process.stderr.write(
          `Stopping early for ${spec.provider}/${spec.phase}; threshold cannot pass.\n`,
        );
        stopAll = true;
        break;
      }
    }
    if (stopAll) {
      break;
    }

    for (let index = 1; index <= spec.resumeAttempts; index += 1) {
      const id = firstSuccessfulIds[index - 1] ?? firstSuccessfulIds[0];
      if (!id) {
        results.push({
          provider: spec.provider,
          phase: spec.phase,
          contract: spec.contract,
          kind: "resume",
          index,
          ok: false,
          exitCode: 1,
          durationMs: 0,
          validationErrors: ["no successful session/thread id available for resume"],
        });
        continue;
      }
      const result = await runResumeAttempt(spec, id, index);
      results.push(result);
      process.stdout.write(formatProgress(result));
    }
  }

  const artifact: MatrixArtifact = {
    generatedAt,
    env: {
      apiKeysUnset: true,
      claudeVersion: await readVersion("claude"),
      codexVersion: await readVersion("codex"),
    },
    specs,
    results,
    summary: summarize(results),
  };
  const artifactPath = join(outDir, `matrix-${generatedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`artifact=${artifactPath}\n`);

  return hasFailures(results) ? 1 : 0;
}

async function runPhaseAttempt(
  spec: PhaseSpec,
  kind: "attempt" | "sandbox",
  index: number,
): Promise<AttemptResult> {
  assertApiKeysUnset();
  const started = Date.now();
  if (spec.provider === "claude") {
    const { stdout, stderr, exitCode } = await runCommand(
      "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--tools",
        "",
        "--setting-sources",
        "project",
        "--json-schema",
        JSON.stringify(schemaFor(spec.contract)),
        promptFor(spec.contract, spec.phase),
      ],
      180_000,
    );
    return parseClaudeResult(spec, kind, index, exitCode, Date.now() - started, stdout, stderr);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "autokit-codex-matrix-"));
  const schemaFile = join(tempDir, "schema.json");
  const outputFile = join(tempDir, "last-message.json");
  await writeFile(schemaFile, JSON.stringify(schemaFor(spec.contract)), "utf8");
  const { stdout, stderr, exitCode } = await runCommand(
    "codex",
    [
      "-a",
      "never",
      "exec",
      "--json",
      "--sandbox",
      spec.sandbox ?? "read-only",
      "--output-schema",
      schemaFile,
      "-o",
      outputFile,
      promptFor(spec.contract, spec.phase),
    ],
    240_000,
  );
  return await parseCodexResult(
    spec,
    kind,
    index,
    exitCode,
    Date.now() - started,
    stdout,
    stderr,
    outputFile,
  );
}

async function runResumeAttempt(
  spec: PhaseSpec,
  id: string,
  index: number,
): Promise<AttemptResult> {
  assertApiKeysUnset();
  const started = Date.now();
  if (spec.provider === "claude") {
    const { stdout, stderr, exitCode } = await runCommand(
      "claude",
      [
        "-p",
        "--resume",
        id,
        "--output-format",
        "json",
        "--tools",
        "",
        "--setting-sources",
        "project",
        "--json-schema",
        JSON.stringify(schemaFor(spec.contract)),
        promptFor(spec.contract, spec.phase, true),
      ],
      180_000,
    );
    return parseClaudeResult(spec, "resume", index, exitCode, Date.now() - started, stdout, stderr);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "autokit-codex-resume-"));
  const outputFile = join(tempDir, "last-message.json");
  const { stdout, stderr, exitCode } = await runCommand(
    "codex",
    [
      "-a",
      "never",
      "exec",
      "resume",
      "--json",
      "-o",
      outputFile,
      id,
      promptFor(spec.contract, spec.phase, true),
    ],
    240_000,
  );
  return await parseCodexResult(
    spec,
    "resume",
    index,
    exitCode,
    Date.now() - started,
    stdout,
    stderr,
    outputFile,
  );
}

function parseClaudeResult(
  spec: PhaseSpec,
  kind: AttemptResult["kind"],
  index: number,
  exitCode: number,
  durationMs: number,
  stdout: string,
  stderr: string,
): AttemptResult {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const payload = parsed.structured_output;
    const validation = validatePromptContract(spec.contract, payload);
    const isError = parsed.is_error === true;
    return {
      provider: spec.provider,
      phase: spec.phase,
      contract: spec.contract,
      kind,
      index,
      ok: exitCode === 0 && !isError && validation.ok,
      exitCode,
      durationMs,
      sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
      validationErrors: validation.errors,
      error: isError ? String(parsed.result ?? stderr) : stderr.trim() || undefined,
      costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined,
    };
  } catch (error) {
    return failedParseResult(spec, kind, index, exitCode, durationMs, error, stderr);
  }
}

async function parseCodexResult(
  spec: PhaseSpec,
  kind: AttemptResult["kind"],
  index: number,
  exitCode: number,
  durationMs: number,
  stdout: string,
  stderr: string,
  outputFile: string,
): Promise<AttemptResult> {
  const threadId = extractCodexThreadId(stdout);
  try {
    const text = await readFile(outputFile, "utf8");
    const payload = JSON.parse(text);
    const validation = validatePromptContract(spec.contract, payload);
    return {
      provider: spec.provider,
      phase: spec.phase,
      contract: spec.contract,
      kind,
      index,
      ok: exitCode === 0 && validation.ok && Boolean(threadId),
      exitCode,
      durationMs,
      threadId,
      validationErrors: validation.errors,
      error: stderr.trim() || undefined,
    };
  } catch (error) {
    return failedParseResult(spec, kind, index, exitCode, durationMs, error, stderr, threadId);
  }
}

function extractCodexThreadId(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        return event.thread_id;
      }
    } catch {
      // Ignore non-JSON warnings; Codex can emit plugin warnings before JSONL events.
    }
  }
  return undefined;
}

function failedParseResult(
  spec: PhaseSpec,
  kind: AttemptResult["kind"],
  index: number,
  exitCode: number,
  durationMs: number,
  error: unknown,
  stderr: string,
  threadId?: string,
): AttemptResult {
  return {
    provider: spec.provider,
    phase: spec.phase,
    contract: spec.contract,
    kind,
    index,
    ok: false,
    exitCode,
    durationMs,
    threadId,
    validationErrors: [error instanceof Error ? error.message : String(error)],
    error: stderr.trim() || undefined,
  };
}

function schemaFor(contract: Contract): Record<string, unknown> {
  const base = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed"] },
      summary: { type: "string" },
      data: dataSchemaFor(contract),
    },
    required: ["status", "summary", "data"],
    additionalProperties: false,
  };
  return base;
}

function dataSchemaFor(contract: Contract): Record<string, unknown> {
  switch (contract) {
    case "plan":
      return objectSchema({
        plan_markdown: { type: "string" },
        assumptions: stringArraySchema(),
        risks: stringArraySchema(),
      });
    case "plan-verify":
      return objectSchema({
        result: { type: "string", enum: ["ok"] },
        findings: { type: "array", items: objectSchema({}), maxItems: 0 },
      });
    case "plan-fix":
      return objectSchema({
        plan_markdown: { type: "string" },
        addressed_findings: stringArraySchema(),
      });
    case "implement":
      return objectSchema({
        changed_files: stringArraySchema(),
        tests_run: testArraySchema(),
        docs_updated: { type: "boolean" },
        notes: { type: "string" },
      });
    case "review":
      return objectSchema({
        findings: { type: "array", items: objectSchema({}), maxItems: 0 },
      });
    case "supervise":
      return objectSchema({
        accept_ids: stringArraySchema(),
        reject_ids: stringArraySchema(),
        reject_reasons: objectSchema({}),
      });
    case "fix":
      return objectSchema({
        changed_files: stringArraySchema(),
        tests_run: testArraySchema(),
        resolved_accept_ids: stringArraySchema(),
        unresolved_accept_ids: stringArraySchema(),
        notes: { type: "string" },
      });
  }
}

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function stringArraySchema(): Record<string, unknown> {
  return { type: "array", items: { type: "string" } };
}

function testArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    items: objectSchema({
      command: { type: "string" },
      result: { type: "string", enum: ["passed", "failed", "skipped"] },
      summary: { type: "string" },
    }),
  };
}

function promptFor(contract: Contract, phase: string, resume = false): string {
  const payload = payloadFor(contract);
  return [
    `#23 runner adoption ${resume ? "resume" : "matrix"} attempt for phase ${phase}.`,
    "Return only JSON matching the provided schema.",
    "Do not edit files. Do not run commands. Do not use network tools.",
    `Exact JSON payload: ${JSON.stringify(payload)}`,
  ].join("\n");
}

function payloadFor(contract: Contract): Record<string, unknown> {
  switch (contract) {
    case "plan":
      return {
        status: "completed",
        summary: "plan ok",
        data: {
          plan_markdown: "## Plan\nNo implementation in adoption matrix.",
          assumptions: [],
          risks: [],
        },
      };
    case "plan-verify":
      return {
        status: "completed",
        summary: "plan verify ok",
        data: { result: "ok", findings: [] },
      };
    case "plan-fix":
      return {
        status: "completed",
        summary: "plan fix ok",
        data: { plan_markdown: "## Plan\nReviewed plan remains valid.", addressed_findings: [] },
      };
    case "implement":
      return {
        status: "completed",
        summary: "implement ok",
        data: {
          changed_files: [],
          tests_run: [],
          docs_updated: false,
          notes: "No file changes in adoption matrix.",
        },
      };
    case "review":
      return { status: "completed", summary: "review ok", data: { findings: [] } };
    case "supervise":
      return {
        status: "completed",
        summary: "supervise ok",
        data: { accept_ids: [], reject_ids: [], reject_reasons: {} },
      };
    case "fix":
      return {
        status: "completed",
        summary: "fix ok",
        data: {
          changed_files: [],
          tests_run: [],
          resolved_accept_ids: [],
          unresolved_accept_ids: [],
          notes: "No file changes in adoption matrix.",
        },
      };
  }
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      env: buildRunnerEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      signal: controller.signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function assertApiKeysUnset(): void {
  const present = API_KEY_NAMES.filter((key) => process.env[key]);
  if (present.length > 0) {
    throw new Error(`Refusing live matrix while API key env is set: ${present.join(", ")}`);
  }
}

async function readVersion(command: string): Promise<string | undefined> {
  const result = await runCommand(command, ["--version"], 30_000);
  return result.exitCode === 0 ? result.stdout.trim() || result.stderr.trim() : undefined;
}

function shouldStopEarly(results: AttemptResult[], spec: PhaseSpec): boolean {
  const attempts = results.filter(
    (result) =>
      result.provider === spec.provider && result.phase === spec.phase && result.kind === "attempt",
  );
  const failures = attempts.filter((result) => !result.ok).length;
  return failures > 1;
}

function summarize(results: AttemptResult[]): Record<string, unknown> {
  const byKey = new Map<string, AttemptResult[]>();
  for (const result of results) {
    const key = `${result.provider}/${result.phase}/${result.kind}`;
    byKey.set(key, [...(byKey.get(key) ?? []), result]);
  }
  return Object.fromEntries(
    [...byKey.entries()].map(([key, items]) => [
      key,
      {
        total: items.length,
        ok: items.filter((item) => item.ok).length,
        failed: items.filter((item) => !item.ok).length,
        successRate: items.length === 0 ? 0 : items.filter((item) => item.ok).length / items.length,
      },
    ]),
  );
}

function hasFailures(results: AttemptResult[]): boolean {
  return results.some((result) => !result.ok);
}

function formatProgress(result: AttemptResult): string {
  const id = result.sessionId ?? result.threadId ?? "no-session";
  return `${result.ok ? "ok" : "fail"} ${result.provider}/${result.phase}/${result.kind} #${result.index} ${id} ${result.durationMs}ms\n`;
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readProvider(args: string[]): Provider | "all" | undefined {
  const provider = readOption(args, "--provider") ?? "all";
  if (provider === "claude" || provider === "codex" || provider === "all") {
    return provider;
  }
  return undefined;
}

function printHelp(): void {
  process.stdout.write(
    `${[
      "Usage:",
      "  bun e2e/runners/runner-adoption-matrix.ts --allow-model-calls --provider claude|codex|all [--out-dir DIR]",
      "",
      "Runs #23 live primary runner adoption matrix. Refuses to run if ANTHROPIC_API_KEY,",
      "OPENAI_API_KEY, or CODEX_API_KEY is set.",
    ].join("\n")}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
