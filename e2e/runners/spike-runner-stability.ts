import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type PromptContract =
  | "plan"
  | "plan-verify"
  | "plan-fix"
  | "implement"
  | "review"
  | "supervise"
  | "fix";

type ValidationResult = {
  ok: boolean;
  code?: "prompt_contract_violation";
  errors: string[];
};

type FixtureExpectation = {
  file: string;
  contract: PromptContract;
  expect: "pass" | "fail";
  code?: "prompt_contract_violation";
  reason: string;
};

type FixtureManifest = {
  fixtures: FixtureExpectation[];
};

type SelfTestResult = {
  total: number;
  passedExpectations: number;
  failClosedCount: number;
  failures: string[];
};

type LiveProvider = "claude" | "codex";

const STRING_LIMIT = 16 * 1024;
const PLAN_MARKDOWN_LIMIT = 64 * 1024;
const PROMPT_CONTRACTS = new Set<PromptContract>([
  "plan",
  "plan-verify",
  "plan-fix",
  "implement",
  "review",
  "supervise",
  "fix",
]);

export function validatePromptContract(
  contract: PromptContract,
  payload: unknown,
): ValidationResult {
  const errors: string[] = [];

  if (!PROMPT_CONTRACTS.has(contract)) {
    return violation([`unknown contract: ${contract}`]);
  }

  if (!isRecord(payload)) {
    return violation(["payload must be an object"]);
  }

  const allowedTopLevel = new Set(["status", "summary", "data", "question"]);
  rejectUnknownKeys(payload, allowedTopLevel, "payload", errors);

  const status = payload.status;
  if (
    status !== "completed" &&
    status !== "need_input" &&
    status !== "paused" &&
    status !== "failed"
  ) {
    errors.push("status must be completed, need_input, paused, or failed");
  }

  requireBoundedString(payload.summary, "summary", STRING_LIMIT, errors);

  if (status === "completed") {
    if (!("data" in payload)) {
      errors.push("completed status requires data");
    } else {
      validateCompletedData(contract, payload.data, errors);
    }
    if ("question" in payload) {
      errors.push("completed status must not include question");
    }
  }

  if (status === "need_input") {
    validateQuestion(payload.question, errors);
    if ("data" in payload) {
      validateCompletedData(contract, payload.data, errors);
    }
  }

  if (status === "paused" || status === "failed") {
    validatePausedOrFailedData(payload.data, errors);
    if ("question" in payload) {
      errors.push(`${status} status must not include question`);
    }
  }

  if (errors.length > 0) {
    return violation(errors);
  }

  return { ok: true, errors: [] };
}

export async function runPromptContractSelfTest(
  fixtureDirUrl = new URL("../fixtures/prompt-contract/", import.meta.url),
): Promise<SelfTestResult> {
  const fixtureDir = fileURLToPath(fixtureDirUrl);
  const manifest = await readJson<FixtureManifest>(join(fixtureDir, "manifest.json"));
  const failures: string[] = [];
  let passedExpectations = 0;
  let failClosedCount = 0;

  for (const fixture of manifest.fixtures) {
    const payload = await readJson<unknown>(join(fixtureDir, fixture.file));
    const result = validatePromptContract(fixture.contract, payload);
    const matches =
      fixture.expect === "pass"
        ? result.ok
        : !result.ok && result.code === (fixture.code ?? "prompt_contract_violation");

    if (matches) {
      passedExpectations += 1;
      if (fixture.expect === "fail") {
        failClosedCount += 1;
      }
      continue;
    }

    failures.push(
      `${fixture.file}: expected ${fixture.expect}, got ${
        result.ok ? "pass" : result.code
      } (${result.errors.join("; ")})`,
    );
  }

  return {
    total: manifest.fixtures.length,
    passedExpectations,
    failClosedCount,
    failures,
  };
}

export function buildClaudeSmokeCommand(): { command: string; args: string[] } {
  return {
    command: "claude",
    args: [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--setting-sources",
      "project",
      "--json-schema",
      JSON.stringify(smokeSchema()),
      smokePrompt(),
    ],
  };
}

export function buildCodexSmokeCommand(schemaFile: string): {
  command: string;
  args: string[];
} {
  return {
    command: "codex",
    args: [
      "-a",
      "never",
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--output-schema",
      schemaFile,
      smokePrompt(),
    ],
  };
}

async function runLiveSmoke(provider: LiveProvider): Promise<number> {
  if (provider === "claude") {
    const { command, args } = buildClaudeSmokeCommand();
    const result = await runCommand(command, args, 120_000);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.exitCode;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "autokit-codex-schema-"));
  const schemaFile = join(tempDir, "schema.json");
  await writeFile(schemaFile, JSON.stringify(smokeSchema()), "utf8");
  const { command, args } = buildCodexSmokeCommand(schemaFile);
  const result = await runCommand(command, args, 120_000);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.exitCode;
}

function validateCompletedData(
  contract: PromptContract,
  data: unknown,
  errors: string[],
): void {
  if (!isRecord(data)) {
    errors.push("data must be an object");
    return;
  }

  switch (contract) {
    case "plan":
      requireExactKeys(data, ["plan_markdown", "assumptions", "risks"], "data", errors);
      requireBoundedString(data.plan_markdown, "data.plan_markdown", PLAN_MARKDOWN_LIMIT, errors);
      validateStringArray(data.assumptions, "data.assumptions", 20, errors);
      validateStringArray(data.risks, "data.risks", 20, errors);
      return;
    case "plan-verify":
      requireExactKeys(data, ["result", "findings"], "data", errors);
      if (data.result !== "ok" && data.result !== "ng") {
        errors.push("data.result must be ok or ng");
      }
      validatePlanVerifyFindings(data.findings, data.result, errors);
      return;
    case "plan-fix":
      requireExactKeys(data, ["plan_markdown", "addressed_findings"], "data", errors);
      requireBoundedString(data.plan_markdown, "data.plan_markdown", PLAN_MARKDOWN_LIMIT, errors);
      validateStringArray(data.addressed_findings, "data.addressed_findings", 20, errors);
      return;
    case "implement":
      requireExactKeys(data, ["changed_files", "tests_run", "docs_updated", "notes"], "data", errors);
      validatePathArray(data.changed_files, "data.changed_files", 200, errors);
      validateTestEvidence(data.tests_run, errors);
      if (typeof data.docs_updated !== "boolean") {
        errors.push("data.docs_updated must be boolean");
      }
      requireBoundedString(data.notes, "data.notes", STRING_LIMIT, errors);
      return;
    case "review":
      requireExactKeys(data, ["findings"], "data", errors);
      validateReviewFindings(data.findings, errors);
      return;
    case "supervise":
      requireExactKeys(
        data,
        ["accept_ids", "reject_ids", "reject_reasons", "fix_prompt"],
        "data",
        errors,
      );
      validateStringArray(data.accept_ids, "data.accept_ids", 50, errors);
      validateStringArray(data.reject_ids, "data.reject_ids", 50, errors);
      validateStringMap(data.reject_reasons, "data.reject_reasons", errors);
      requireBoundedString(data.fix_prompt, "data.fix_prompt", 32 * 1024, errors);
      return;
    case "fix":
      requireExactKeys(
        data,
        ["changed_files", "tests_run", "resolved_accept_ids", "unresolved_accept_ids", "notes"],
        "data",
        errors,
      );
      validatePathArray(data.changed_files, "data.changed_files", 200, errors);
      validateTestEvidence(data.tests_run, errors);
      validateStringArray(data.resolved_accept_ids, "data.resolved_accept_ids", 50, errors);
      validateStringArray(data.unresolved_accept_ids, "data.unresolved_accept_ids", 50, errors);
      requireBoundedString(data.notes, "data.notes", STRING_LIMIT, errors);
      return;
  }
}

function validateQuestion(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("need_input status requires question");
    return;
  }

  requireExactKeys(value, ["text", "default"], "question", errors);
  requireBoundedString(value.text, "question.text", STRING_LIMIT, errors);
  requireBoundedString(value.default, "question.default", STRING_LIMIT, errors);
}

function validatePausedOrFailedData(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("paused/failed status requires data");
    return;
  }

  rejectUnknownKeys(value, new Set(["reason", "recoverable"]), "data", errors);
  requireBoundedString(value.reason, "data.reason", STRING_LIMIT, errors);
  if ("recoverable" in value && typeof value.recoverable !== "boolean") {
    errors.push("data.recoverable must be boolean when present");
  }
}

function validatePlanVerifyFindings(
  value: unknown,
  result: unknown,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push("data.findings must be an array");
    return;
  }
  if (value.length > 20) {
    errors.push("data.findings must contain at most 20 items");
  }
  if (result === "ok" && value.length !== 0) {
    errors.push('data.findings must be empty when data.result is "ok"');
  }
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      errors.push(`data.findings[${index}] must be an object`);
      continue;
    }
    requireExactKeys(
      item,
      ["severity", "title", "rationale", "required_change"],
      `data.findings[${index}]`,
      errors,
    );
    if (!["blocker", "major", "minor"].includes(String(item.severity))) {
      errors.push(`data.findings[${index}].severity is invalid`);
    }
    requireBoundedString(item.title, `data.findings[${index}].title`, STRING_LIMIT, errors);
    requireBoundedString(item.rationale, `data.findings[${index}].rationale`, STRING_LIMIT, errors);
    requireBoundedString(
      item.required_change,
      `data.findings[${index}].required_change`,
      STRING_LIMIT,
      errors,
    );
  }
}

function validateReviewFindings(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("data.findings must be an array");
    return;
  }
  if (value.length > 50) {
    errors.push("data.findings must contain at most 50 items");
  }
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      errors.push(`data.findings[${index}] must be an object`);
      continue;
    }
    requireExactKeys(
      item,
      ["severity", "file", "line", "title", "rationale", "suggested_fix"],
      `data.findings[${index}]`,
      errors,
    );
    if (!["P0", "P1", "P2", "P3"].includes(String(item.severity))) {
      errors.push(`data.findings[${index}].severity is invalid`);
    }
    requireRelativePath(item.file, `data.findings[${index}].file`, errors);
    if (item.line !== null && !isInteger(item.line)) {
      errors.push(`data.findings[${index}].line must be integer or null`);
    }
    requireBoundedString(item.title, `data.findings[${index}].title`, STRING_LIMIT, errors);
    requireBoundedString(item.rationale, `data.findings[${index}].rationale`, STRING_LIMIT, errors);
    requireBoundedString(
      item.suggested_fix,
      `data.findings[${index}].suggested_fix`,
      STRING_LIMIT,
      errors,
    );
  }
}

function validateTestEvidence(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("data.tests_run must be an array");
    return;
  }
  if (value.length > 20) {
    errors.push("data.tests_run must contain at most 20 items");
  }
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      errors.push(`data.tests_run[${index}] must be an object`);
      continue;
    }
    requireExactKeys(item, ["command", "result", "summary"], `data.tests_run[${index}]`, errors);
    requireBoundedString(item.command, `data.tests_run[${index}].command`, STRING_LIMIT, errors);
    if (!["passed", "failed", "skipped"].includes(String(item.result))) {
      errors.push(`data.tests_run[${index}].result is invalid`);
    }
    requireBoundedString(item.summary, `data.tests_run[${index}].summary`, STRING_LIMIT, errors);
  }
}

function validateStringArray(
  value: unknown,
  path: string,
  maxItems: number,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (value.length > maxItems) {
    errors.push(`${path} must contain at most ${maxItems} items`);
  }
  for (const [index, item] of value.entries()) {
    requireBoundedString(item, `${path}[${index}]`, STRING_LIMIT, errors);
  }
}

function validatePathArray(
  value: unknown,
  path: string,
  maxItems: number,
  errors: string[],
): void {
  validateStringArray(value, path, maxItems, errors);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      requireRelativePath(item, `${path}[${index}]`, errors);
    }
  }
}

function validateStringMap(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    requireBoundedString(key, `${path} key`, STRING_LIMIT, errors);
    requireBoundedString(item, `${path}.${key}`, STRING_LIMIT, errors);
  }
}

function requireRelativePath(value: unknown, path: string, errors: string[]): void {
  requireBoundedString(value, path, STRING_LIMIT, errors);
  if (typeof value !== "string") {
    return;
  }
  if (value.startsWith("/") || value.includes("..")) {
    errors.push(`${path} must be a repo-relative path`);
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: string[],
  path: string,
  errors: string[],
): void {
  rejectUnknownKeys(value, new Set(keys), path, errors);
  for (const key of keys) {
    if (!(key in value)) {
      errors.push(`${path}.${key} is required`);
    }
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${path}.${key} is not allowed`);
    }
  }
}

function requireBoundedString(
  value: unknown,
  path: string,
  maxBytes: number,
  errors: string[],
): void {
  if (typeof value !== "string") {
    errors.push(`${path} must be a string`);
    return;
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    errors.push(`${path} must be ${maxBytes} bytes or less`);
  }
}

function isInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function violation(errors: string[]): ValidationResult {
  return { ok: false, code: "prompt_contract_violation", errors };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function smokeSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed"] },
      summary: { type: "string" },
      data: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    required: ["status", "summary", "data"],
    additionalProperties: false,
  };
}

function smokePrompt(): string {
  return [
    "Return only the requested structured output:",
    "status completed, summary ok, data.ok true.",
    "Do not edit files or run commands.",
  ].join(" ");
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

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const fixtureDirIndex = args.indexOf("--fixture-dir");
  const fixtureDir =
    fixtureDirIndex >= 0
      ? pathToFileURL(join(process.cwd(), args[fixtureDirIndex + 1] ?? "") + "/")
      : new URL("../fixtures/prompt-contract/", import.meta.url);
  const json = args.includes("--json");

  if (args.includes("--help")) {
    printHelp();
    return 0;
  }

  if (args.includes("--self-test")) {
    const result = await runPromptContractSelfTest(fixtureDir);
    const output = json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `prompt_contract fixtures: ${result.passedExpectations}/${result.total} expectations passed`,
          `fail-closed fixtures: ${result.failClosedCount}`,
          result.failures.length > 0 ? `failures: ${result.failures.join("; ")}` : "failures: none",
        ].join("\n") + "\n";
    process.stdout.write(output);
    return result.failures.length === 0 ? 0 : 1;
  }

  const liveProvider = readOption(args, "--live-provider");
  if (liveProvider) {
    if (!args.includes("--allow-model-calls")) {
      process.stderr.write(
        "--live-provider requires --allow-model-calls to avoid accidental subscription/API usage.\n",
      );
      return 2;
    }
    if (liveProvider !== "claude" && liveProvider !== "codex") {
      process.stderr.write("--live-provider must be claude or codex.\n");
      return 2;
    }
    return await runLiveSmoke(liveProvider);
  }

  printHelp();
  return 2;
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  node --test --experimental-strip-types e2e/runners/spike-runner-stability.test.ts",
      "  node --experimental-strip-types e2e/runners/spike-runner-stability.ts --self-test [--json]",
      "  node --experimental-strip-types e2e/runners/spike-runner-stability.ts --live-provider claude|codex --allow-model-calls",
      "",
      "The live provider mode runs a single structured-output smoke only. Full N=20 adoption",
      "matrices should be run explicitly and recorded in docs/spike-results.md.",
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
