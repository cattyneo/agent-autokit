import { lstat, readdir, readFile, realpath } from "node:fs/promises";
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

type PromptAssetVisibilityGateOptions = {
  assetsRootUrl?: URL;
  mappingUrl?: URL;
};

type SkillAssetQualityGateOptions = {
  assetsRootUrl?: URL;
  repoRootUrl?: URL;
};

type PromptAssetVisibilityGateResult = {
  total: number;
  passed: number;
  failures: string[];
  promptFiles: string[];
  presetEffectivePrompts: string[];
  markerSections: string[];
  checks: VisibilityCheck[];
};

type SkillAssetQualityGateResult = {
  total: number;
  passed: number;
  failures: string[];
  skills: string[];
  checkedSkillAssets: string[];
  sourcePins: Record<"autokit-implement" | "autokit-review", string>;
  checks: VisibilityCheck[];
};

type AgentAssetQualityGateResult = {
  total: number;
  passed: number;
  failures: string[];
  agents: string[];
  checkedAgentAssets: string[];
  checks: VisibilityCheck[];
};

type PromptMappingRow = {
  promptContract: string;
  field: string;
  mdSection: string;
  promptFile: string;
  presetEffectivePrompt: string;
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
const MARKER_SECTIONS = ["## Result", "## Evidence", "## Changes", "## Test results"];
const IMPLEMENT_SOURCE_COMMIT = "866d9ebb5364a579ac7d2a8fb79bb421bf9d7052";
const REVIEW_SOURCE_SHA256 = "b95eddbaa3e3c671c657084d8919a0a34d031dec60a6228d08158514a742d7f5";
const IMPLEMENT_SKILL_TOKENS = [
  "Source alignment",
  "tdd-workflow",
  IMPLEMENT_SOURCE_COMMIT,
  "prompt_contract",
  "`implement`",
  "`fix`",
  "`changed_files`",
  "`tests_run`",
  "`docs_updated`",
  "`notes`",
  "RED",
  "GREEN",
  "REFACTOR",
  "doc-updater",
  "autokit-question",
];
const REVIEW_SKILL_TOKENS = [
  "Source alignment",
  "general-review",
  REVIEW_SOURCE_SHA256,
  "prompt_contract",
  "`review`",
  "`data.findings`",
  "`severity`",
  "`file`",
  "`line`",
  "`title`",
  "`rationale`",
  "`suggested_fix`",
  "P0",
  "P1",
  "P2",
  "P3",
  "supervisor",
  "read-only",
  "autokit-question",
];
const REVIEW_SKILL_FORBIDDEN_TOKENS = [" / `findings`", "`findings` must"];
const AGENT_QUALITY_SECTIONS = [
  "## Role",
  "## Do",
  "## Don't",
  "## Decision Rules",
  "## Permission Boundary",
  "## Source of Truth",
  "## AI Anti-Patterns",
  "## Output",
];
const AGENT_ASSET_TOKENS: Record<(typeof AGENTS)[number], string[]> = {
  planner: [
    "`plan`",
    "`plan_fix`",
    "`readonly_repo`",
    "Read / Grep / Glob",
    "Do not edit files",
    "`data.plan_markdown`",
    "`data.addressed_findings`",
  ],
  "plan-verifier": [
    "`plan_verify`",
    "`readonly_repo`",
    "Do not execute shell commands",
    "`data.result`",
    "`data.findings`",
  ],
  implementer: [
    "`implement`",
    "`fix`",
    "`write_worktree`",
    "assigned worktree",
    "Do not run git",
    "`data.changed_files`",
    "`data.tests_run`",
    "`data.docs_updated`",
    "`data.resolved_accept_ids`",
  ],
  reviewer: [
    "`review`",
    "`readonly_worktree`",
    "Do not edit files",
    "`data.findings`",
    "`suggested_fix`",
    "sanitize",
  ],
  supervisor: [
    "`supervise`",
    "`readonly_worktree`",
    "Do not edit files",
    "`data.accept_ids`",
    "`data.reject_ids`",
    "`data.fix_prompt`",
    "reject_history",
  ],
  "doc-updater": [
    "`doc-updater`",
    "`write_worktree`",
    "implement/fix",
    "documentation path",
    "docs / guide / spec / README",
    "Do not run git",
    "delegating implement/fix prompt_contract",
  ],
};
const AGENT_SECTION_TOKENS: Record<
  (typeof AGENTS)[number],
  Partial<Record<(typeof AGENT_QUALITY_SECTIONS)[number], string[]>>
> = {
  planner: {
    "## Permission Boundary": ["`readonly_repo`", "Read / Grep / Glob"],
    "## Output": ["`data.plan_markdown`", "`data.addressed_findings`"],
  },
  "plan-verifier": {
    "## Don't": ["Do not execute shell commands"],
    "## Permission Boundary": ["`readonly_repo`"],
    "## Output": ["`data.result`", "`data.findings`"],
  },
  implementer: {
    "## Don't": ["Do not run git"],
    "## Permission Boundary": ["`write_worktree`", "assigned worktree"],
    "## Output": ["`data.changed_files`", "`data.tests_run`", "`data.docs_updated`"],
  },
  reviewer: {
    "## Permission Boundary": ["`readonly_worktree`"],
    "## Output": ["`data.findings`", "`suggested_fix`"],
  },
  supervisor: {
    "## Permission Boundary": ["`readonly_worktree`"],
    "## Source of Truth": ["`reject_history`"],
    "## Output": ["`data.accept_ids`", "`data.reject_ids`", "`data.fix_prompt`"],
  },
  "doc-updater": {
    "## Permission Boundary": ["`write_worktree`", "documentation path"],
    "## Source of Truth": ["`docs/spec/*.md`"],
    "## Output": ["delegating implement/fix prompt_contract", "`data.docs_updated`"],
  },
};

export async function runPromptAssetVisibilityGate(
  options: PromptAssetVisibilityGateOptions = {},
): Promise<PromptAssetVisibilityGateResult> {
  const assetsRoot = fileURLToPath(
    options.assetsRootUrl ?? new URL("../../packages/cli/assets/", import.meta.url),
  );
  const mappingPath = fileURLToPath(
    options.mappingUrl ?? new URL("../fixtures/prompt-contract/mapping.md", import.meta.url),
  );
  const checks: VisibilityCheck[] = [];
  const mapping = await readMappingRows(mappingPath);
  const promptFiles = await listPromptFiles(join(assetsRoot, "prompts"));
  const promptFileNames = promptFiles.map((item) => item.replace(/\.md$/, ""));
  const presetEffectivePrompts: string[] = [];

  await check(checks, "prompt assets include exactly the fixed prompt contracts", async () => {
    const unexpected = promptFileNames.filter(
      (contract) => !(PROMPT_CONTRACTS as readonly string[]).includes(contract),
    );
    const missing = PROMPT_CONTRACTS.filter((contract) => !promptFileNames.includes(contract));
    if (unexpected.length > 0 || missing.length > 0) {
      throw new Error(
        `unexpected prompt asset: ${unexpected.join(",") || "-"}; missing=${missing.join(",") || "-"}`,
      );
    }
  });

  for (const contract of PROMPT_CONTRACTS) {
    const promptFile = `packages/cli/assets/prompts/${contract}.md`;
    const text = await readText(assetsRoot, "prompts", `${contract}.md`);
    await check(checks, `prompt markers: ${contract}`, async () =>
      requireMarkerSections(`${contract}.md`, text),
    );
    await check(checks, `prompt mapping: ${contract}`, async () =>
      requireMappingCoverage(mapping, {
        contract,
        promptFile,
        presetEffectivePrompt: "base",
      }),
    );
  }

  for (const preset of await listPresetNames(join(assetsRoot, "presets"))) {
    for (const contract of PROMPT_CONTRACTS) {
      const overridePath = join(assetsRoot, "presets", preset, "prompts", `${contract}.md`);
      const override = await readOptionalText(overridePath);
      const text = override ?? (await readText(assetsRoot, "prompts", `${contract}.md`));
      const effectivePrompt = `preset:${preset}/prompts/${contract}.md`;
      presetEffectivePrompts.push(effectivePrompt);
      await check(checks, `preset prompt markers: ${preset}/${contract}`, async () =>
        requireMarkerSections(effectivePrompt, text),
      );
      await check(checks, `preset prompt mapping: ${preset}/${contract}`, async () =>
        requireMappingCoverage(mapping, {
          contract,
          promptFile: `packages/cli/assets/prompts/${contract}.md`,
          presetEffectivePrompt: effectivePrompt,
        }),
      );
    }

    for (const override of await listPromptFilesDeep(
      join(assetsRoot, "presets", preset, "prompts"),
    )) {
      const contract = override.replace(/\.md$/, "");
      await check(checks, `preset prompt contract: ${preset}/${contract}`, async () => {
        if (!(PROMPT_CONTRACTS as readonly string[]).includes(contract)) {
          throw new Error(`unexpected preset prompt asset: ${preset}/prompts/${contract}`);
        }
      });
    }
  }

  const failures = checks
    .filter((result) => !result.ok)
    .map((result) => `${result.name}: ${result.message ?? "failed"}`);

  return {
    total: checks.length,
    passed: checks.length - failures.length,
    failures,
    promptFiles,
    presetEffectivePrompts,
    markerSections: MARKER_SECTIONS,
    checks,
  };
}

export async function runRunnerVisibilitySelfTest(
  fixtureRootUrl = new URL("../fixtures/runner-visibility/", import.meta.url),
): Promise<VisibilitySelfTestResult> {
  const root = await realpath(fileURLToPath(fixtureRootUrl));
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

export async function runSkillAssetQualityGate(
  options: SkillAssetQualityGateOptions = {},
): Promise<SkillAssetQualityGateResult> {
  const assetsRoot = fileURLToPath(
    options.assetsRootUrl ?? new URL("../../packages/cli/assets/", import.meta.url),
  );
  const repoRoot = fileURLToPath(options.repoRootUrl ?? new URL("../../", import.meta.url));
  const checks: VisibilityCheck[] = [];
  const checkedSkillAssets: string[] = [];

  for (const skill of await collectSkillAssets(assetsRoot, "autokit-implement")) {
    checkedSkillAssets.push(skill.label);
    await check(checks, `${skill.label} aligns with prompt_contract`, async () =>
      requireTokens(skill.label, skill.text, IMPLEMENT_SKILL_TOKENS),
    );
  }

  for (const skill of await collectSkillAssets(assetsRoot, "autokit-review")) {
    checkedSkillAssets.push(skill.label);
    await check(checks, `${skill.label} aligns with prompt_contract`, async () => {
      requireTokens(skill.label, skill.text, REVIEW_SKILL_TOKENS);
      rejectTokens(skill.label, skill.text, REVIEW_SKILL_FORBIDDEN_TOKENS);
    });
  }

  await check(checks, "SPEC records skill source pins", async () =>
    requireTokens("docs/SPEC.md", await readText(repoRoot, "docs", "SPEC.md"), [
      "コピー元 pin",
      "tdd-workflow",
      IMPLEMENT_SOURCE_COMMIT,
      "general-review",
      REVIEW_SOURCE_SHA256,
    ]),
  );

  await check(checks, "CONTRIBUTING records skill upstream sync duties", async () =>
    requireTokens("CONTRIBUTING.md", await readText(repoRoot, "CONTRIBUTING.md"), [
      "Skill Source Sync",
      "tdd-workflow",
      IMPLEMENT_SOURCE_COMMIT,
      "general-review",
      REVIEW_SOURCE_SHA256,
      "runner-visibility",
      "prompt_contract",
    ]),
  );

  const failures = checks
    .filter((result) => !result.ok)
    .map((result) => `${result.name}: ${result.message ?? "failed"}`);

  return {
    total: checks.length,
    passed: checks.length - failures.length,
    failures,
    skills: ["autokit-implement", "autokit-review"],
    checkedSkillAssets,
    sourcePins: {
      "autokit-implement": IMPLEMENT_SOURCE_COMMIT,
      "autokit-review": REVIEW_SOURCE_SHA256,
    },
    checks,
  };
}

export async function runAgentAssetQualityGate(
  options: SkillAssetQualityGateOptions = {},
): Promise<AgentAssetQualityGateResult> {
  const assetsRoot = fileURLToPath(
    options.assetsRootUrl ?? new URL("../../packages/cli/assets/", import.meta.url),
  );
  const checks: VisibilityCheck[] = [];
  const checkedAgentAssets: string[] = [];
  const agentFiles = await listAgentFiles(join(assetsRoot, "agents"));

  await check(checks, "agent assets include exactly the fixed bundled agents", async () => {
    const expected = AGENTS.map((agent) => `${agent}.md`).sort();
    const unexpected = agentFiles.filter((file) => !expected.includes(file));
    const missing = expected.filter((file) => !agentFiles.includes(file));
    if (unexpected.length > 0 || missing.length > 0) {
      throw new Error(
        `unexpected agent asset: ${unexpected.join(",") || "-"}; missing=${missing.join(",") || "-"}`,
      );
    }
  });

  for (const agent of AGENTS) {
    const label = `base:agents/${agent}.md`;
    const text = await readText(assetsRoot, "agents", `${agent}.md`);
    checkedAgentAssets.push(label);
    await check(checks, `${label} declares phase role and boundaries`, async () => {
      requireTokens(label, text, [...AGENT_QUALITY_SECTIONS, ...AGENT_ASSET_TOKENS[agent]]);
      requireMarkdownSections(label, text, AGENT_QUALITY_SECTIONS);
      requireSectionTokens(label, text, AGENT_SECTION_TOKENS[agent]);
    });
  }

  const failures = checks
    .filter((result) => !result.ok)
    .map((result) => `${result.name}: ${result.message ?? "failed"}`);

  return {
    total: checks.length,
    passed: checks.length - failures.length,
    failures,
    agents: AGENTS,
    checkedAgentAssets,
    checks,
  };
}

async function listAgentFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function collectSkillAssets(
  assetsRoot: string,
  skillName: "autokit-implement" | "autokit-review",
): Promise<Array<{ label: string; text: string }>> {
  const skills = [
    {
      label: `base:skills/${skillName}/SKILL.md`,
      text: await readText(assetsRoot, "skills", skillName, "SKILL.md"),
    },
  ];

  for (const preset of await listPresetNames(join(assetsRoot, "presets"))) {
    const text = await readOptionalText(
      join(assetsRoot, "presets", preset, "skills", skillName, "SKILL.md"),
    );
    if (text !== null) {
      skills.push({
        label: `preset:${preset}/skills/${skillName}/SKILL.md`,
        text,
      });
    }
  }

  return skills;
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

async function listPromptFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listPromptFilesDeep(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const target = join(root, entry.name);
        if (entry.isDirectory()) {
          return (await listPromptFilesDeep(target)).map((item) => `${entry.name}/${item}`);
        }
        return entry.isFile() && entry.name.endsWith(".md") ? [entry.name] : [];
      }),
    );
    return files.flat().sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listPresetNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function requireMarkerSections(label: string, text: string): void {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  let lastIndex = -1;
  for (const section of MARKER_SECTIONS) {
    const index = lines.indexOf(section);
    if (index === -1) {
      throw new Error(`${label} missing marker ${section}`);
    }
    if (index <= lastIndex) {
      throw new Error(`${label} marker ${section} is out of order`);
    }
    lastIndex = index;
  }
}

async function readMappingRows(path: string): Promise<PromptMappingRow[]> {
  const source = await readFile(path, "utf8");
  const rows = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^-+$/.test(cell)));
  const [header, ...body] = rows;
  if (header === undefined) {
    throw new Error("mapping table missing header");
  }
  const index = (name: string) => {
    const value = header.indexOf(name);
    if (value === -1) {
      throw new Error(`mapping table missing column ${name}`);
    }
    return value;
  };
  const contractIndex = index("prompt_contract");
  const fieldIndex = index("field");
  const sectionIndex = index("md_section");
  const promptFileIndex = index("prompt_file");
  const presetIndex = index("preset_effective_prompt");

  return body.map((cells) => ({
    promptContract: cells[contractIndex] ?? "",
    field: cells[fieldIndex] ?? "",
    mdSection: cells[sectionIndex] ?? "",
    promptFile: cells[promptFileIndex] ?? "",
    presetEffectivePrompt: cells[presetIndex] ?? "",
  }));
}

function requireMappingCoverage(
  rows: PromptMappingRow[],
  input: { contract: string; promptFile: string; presetEffectivePrompt: string },
): void {
  for (const section of MARKER_SECTIONS) {
    const found = rows.some(
      (row) =>
        row.promptContract === input.contract &&
        row.mdSection === section &&
        row.promptFile === input.promptFile &&
        row.presetEffectivePrompt === input.presetEffectivePrompt &&
        row.field.length > 0,
    );
    if (!found) {
      throw new Error(`mapping missing for ${input.presetEffectivePrompt} ${section}`);
    }
  }
}

function requireTokens(label: string, text: string, tokens: string[]): void {
  const missing = tokens.filter((token) => !text.includes(token));
  if (missing.length > 0) {
    throw new Error(`${label} missing ${missing.join(", ")}`);
  }
}

function requireMarkdownSections(label: string, text: string, sections: readonly string[]): void {
  const sectionMap = parseMarkdownSections(text);
  const missing = sections.filter((section) => !sectionMap.has(section));
  const empty = sections.filter((section) => (sectionMap.get(section) ?? "").trim().length < 20);
  if (missing.length > 0 || empty.length > 0) {
    throw new Error(
      `${label} invalid sections missing=${missing.join(",") || "-"} empty=${empty.join(",") || "-"}`,
    );
  }
}

function requireSectionTokens(
  label: string,
  text: string,
  requirements: Partial<Record<string, string[]>>,
): void {
  const sectionMap = parseMarkdownSections(text);
  for (const [section, tokens] of Object.entries(requirements)) {
    const sectionText = sectionMap.get(section) ?? "";
    const missing = tokens.filter((token) => !sectionText.includes(token));
    if (missing.length > 0) {
      throw new Error(`${label} ${section} missing ${missing.join(", ")}`);
    }
  }
}

function parseMarkdownSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let current: string | null = null;
  let buffer: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current !== null) {
        sections.set(current, buffer.join("\n"));
      }
      current = line.trim();
      buffer = [];
      continue;
    }
    if (current !== null) {
      buffer.push(line);
    }
  }

  if (current !== null) {
    sections.set(current, buffer.join("\n"));
  }

  return sections;
}

function rejectTokens(label: string, text: string, tokens: string[]): void {
  const found = tokens.filter((token) => text.includes(token));
  if (found.length > 0) {
    throw new Error(`${label} must not contain ${found.join(", ")}`);
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
