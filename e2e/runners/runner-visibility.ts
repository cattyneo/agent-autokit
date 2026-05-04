import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Provider = "claude" | "codex";
type PromptContract =
  | "plan"
  | "plan-verify"
  | "plan-fix"
  | "implement"
  | "review"
  | "supervise"
  | "fix";

type VisibilityCheck = {
  name: string;
  ok: boolean;
  message?: string;
};

type VisibilitySelfTestResult = {
  total: number;
  passed: number;
  failures: string[];
  providers: Provider[];
  promptContracts: PromptContract[];
  checks: VisibilityCheck[];
};

const PROVIDERS: Provider[] = ["claude", "codex"];
const PROMPT_CONTRACTS: PromptContract[] = [
  "plan",
  "plan-verify",
  "plan-fix",
  "implement",
  "review",
  "supervise",
  "fix",
];
const SKILLS = ["autokit-implement", "autokit-review", "autokit-question"];
const AGENTS = ["planner", "plan-verifier", "implementer", "reviewer", "supervisor", "doc-updater"];
const QUESTION_REF = "Use the bundled autokit-question skill for status=need_input responses.";
const IMPLEMENT_REF = "Use the bundled autokit-implement skill.";
const REVIEW_REF = "Use the bundled autokit-review skill.";

export async function runRunnerVisibilitySelfTest(
  fixtureRootUrl = new URL("../fixtures/runner-visibility/", import.meta.url),
): Promise<VisibilitySelfTestResult> {
  const root = fileURLToPath(fixtureRootUrl);
  const checks: VisibilityCheck[] = [];

  await check(checks, "manifest file exists", () => requireFile(root, "manifest.json"));
  await check(checks, "fixed issue input exists", () => requireFile(root, "issue.md"));

  for (const skill of SKILLS) {
    await check(checks, `skill visible in .agents: ${skill}`, () =>
      requireFile(root, ".agents", "skills", skill, "SKILL.md"),
    );
  }

  for (const agent of AGENTS) {
    await check(checks, `agent visible in .agents: ${agent}`, () =>
      requireFile(root, ".agents", "agents", `${agent}.md`),
    );
  }

  for (const contract of PROMPT_CONTRACTS) {
    await check(checks, `prompt_contract runtime file exists: ${contract}`, () =>
      requireFile(root, ".agents", "prompts", `${contract}.md`),
    );
  }

  await check(checks, "provider roots exist", async () => {
    for (const provider of PROVIDERS) {
      await requireDirectory(root, `.${provider}`);
    }
  });

  for (const provider of PROVIDERS) {
    for (const kind of ["skills", "agents"] as const) {
      await check(checks, `${provider} ${kind} symlink resolves into .agents`, () =>
        requireProviderSymlink(root, provider, kind),
      );
    }
  }

  for (const provider of PROVIDERS) {
    await check(checks, `${provider} provider prompt directory is absent`, () =>
      requireAbsent(root, `.${provider}`, "prompts"),
    );
  }

  await check(checks, "all prompts reference autokit-question exactly once", () =>
    requireAutokitQuestionReferences(root),
  );
  await check(checks, "phase prompts reference only their expected bundled skills", () =>
    requirePhaseSkillReferences(root),
  );
  await check(checks, "fixed issue input declares need_input default-answer scenario", () =>
    requireIssueFixture(root),
  );
  await check(checks, "manifest declares providers and prompt contracts", () =>
    requireManifest(root),
  );

  const failures = checks
    .filter((result) => !result.ok)
    .map((result) => `${result.name}: ${result.message ?? "failed"}`);

  return {
    total: checks.length,
    passed: checks.length - failures.length,
    failures,
    providers: PROVIDERS,
    promptContracts: PROMPT_CONTRACTS,
    checks,
  };
}

async function check(
  checks: VisibilityCheck[],
  name: string,
  assertion: () => Promise<void>,
): Promise<void> {
  try {
    await assertion();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function requireFile(root: string, ...segments: string[]): Promise<void> {
  const target = join(root, ...segments);
  const stat = await lstat(target);
  if (!stat.isFile()) {
    throw new Error(`${target} is not a file`);
  }
}

async function requireDirectory(root: string, ...segments: string[]): Promise<void> {
  const target = join(root, ...segments);
  const stat = await lstat(target);
  if (!stat.isDirectory()) {
    throw new Error(`${target} is not a directory`);
  }
}

async function requireAbsent(root: string, ...segments: string[]): Promise<void> {
  const target = join(root, ...segments);
  try {
    await lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`${target} must not exist`);
}

async function requireProviderSymlink(
  root: string,
  provider: Provider,
  kind: "skills" | "agents",
): Promise<void> {
  const linkPath = join(root, `.${provider}`, kind);
  const stat = await lstat(linkPath);
  if (!stat.isSymbolicLink()) {
    throw new Error(`${linkPath} is not a symlink`);
  }

  const expectedPath = join(root, ".agents", kind);
  const expectedStat = await lstat(expectedPath);
  if (!expectedStat.isDirectory()) {
    throw new Error(`${expectedPath} must be a real directory`);
  }

  const resolved = await realpath(linkPath);
  const expected = await realpath(expectedPath);
  requireInside(root, expected, expectedPath);
  if (resolved !== expected) {
    throw new Error(`${linkPath} resolves to ${resolved}, expected ${expected}`);
  }
}

async function requireAutokitQuestionReferences(root: string): Promise<void> {
  for (const contract of PROMPT_CONTRACTS) {
    const text = await readText(root, ".agents", "prompts", `${contract}.md`);
    const lines = nonEmptyLines(text);
    const refs = lines.filter((line) => line.includes("autokit-question"));
    if (refs.length !== 1 || refs[0] !== QUESTION_REF) {
      throw new Error(`${contract}.md must contain exactly one autokit-question resolver line`);
    }
    if (lines.at(-1) !== QUESTION_REF) {
      throw new Error(`${contract}.md must end with the autokit-question resolver line`);
    }
  }
}

async function requirePhaseSkillReferences(root: string): Promise<void> {
  for (const contract of PROMPT_CONTRACTS) {
    const text = await readText(root, ".agents", "prompts", `${contract}.md`);
    const lines = nonEmptyLines(text);
    const implementRefs = lines.filter((line) => line.includes("autokit-implement"));
    const reviewRefs = lines.filter((line) => line.includes("autokit-review"));
    const questionIndex = lines.lastIndexOf(QUESTION_REF);

    if (contract === "implement" || contract === "fix") {
      if (
        implementRefs.length !== 1 ||
        implementRefs[0] !== IMPLEMENT_REF ||
        lines.indexOf(IMPLEMENT_REF) !== questionIndex - 1 ||
        reviewRefs.length !== 0
      ) {
        throw new Error(`${contract}.md must reference autokit-implement only`);
      }
      continue;
    }

    if (contract === "review") {
      if (
        implementRefs.length !== 0 ||
        reviewRefs.length !== 1 ||
        reviewRefs[0] !== REVIEW_REF ||
        lines.indexOf(REVIEW_REF) !== questionIndex - 1
      ) {
        throw new Error("review.md must reference autokit-review only");
      }
      continue;
    }

    if (implementRefs.length !== 0 || reviewRefs.length !== 0) {
      throw new Error(`${contract}.md must not reference implement/review skills`);
    }
  }
}

async function requireIssueFixture(root: string): Promise<void> {
  const text = await readText(root, "issue.md");
  for (const token of [
    "AK-002-FIXTURE",
    "autokit-question",
    "status=need_input",
    "default answer is `node:test`",
  ]) {
    if (!text.includes(token)) {
      throw new Error(`issue.md missing ${token}`);
    }
  }
}

async function requireManifest(root: string): Promise<void> {
  const manifest = JSON.parse(await readText(root, "manifest.json")) as {
    providers?: unknown;
    prompt_contracts?: unknown;
    skills?: unknown;
    agents?: unknown;
    live_model_calls?: unknown;
  };
  assertStringArray("providers", manifest.providers, PROVIDERS);
  assertStringArray("prompt_contracts", manifest.prompt_contracts, PROMPT_CONTRACTS);
  assertStringArray("skills", manifest.skills, SKILLS);
  assertStringArray("agents", manifest.agents, AGENTS);
  if (manifest.live_model_calls !== false) {
    throw new Error("live_model_calls must be false for AK-002");
  }
}

function assertStringArray(name: string, actual: unknown, expected: string[]): void {
  if (!Array.isArray(actual)) {
    throw new Error(`${name} must be an array`);
  }
  if (!actual.every((item) => typeof item === "string")) {
    throw new Error(`${name} must contain only strings`);
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} must be ${expected.join(", ")}`);
  }
}

function requireInside(root: string, target: string, label: string): void {
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/") || rel.startsWith("\\")) {
    throw new Error(`${label} resolves outside fixture root: ${target}`);
  }
}

async function readText(root: string, ...segments: string[]): Promise<string> {
  return await readFile(join(root, ...segments), "utf8");
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  if (!args.has("--self-test")) {
    process.stderr.write("Usage: runner-visibility.ts --self-test [--json]\n");
    return 2;
  }

  const result = await runRunnerVisibilitySelfTest();
  if (args.has("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const item of result.checks) {
      process.stdout.write(`${item.ok ? "ok" : "not ok"} - ${item.name}\n`);
      if (!item.ok && item.message) {
        process.stdout.write(`  ${item.message}\n`);
      }
    }
  }

  return result.failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
