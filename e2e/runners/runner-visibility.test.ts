import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  runAgentAssetQualityGate,
  runPromptAssetVisibilityGate,
  runRunnerVisibilitySelfTest,
  runSkillAssetQualityGate,
} from "./runner-visibility.ts";

const FIXTURE_URL = new URL("../fixtures/runner-visibility/", import.meta.url);

describe("runner visibility spike fixtures", () => {
  it("keeps provider-visible skills and agents rooted in .agents", async () => {
    const result = await runRunnerVisibilitySelfTest(FIXTURE_URL);

    assert.equal(result.total, 29);
    assert.equal(result.passed, 29);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.providers, ["claude", "codex"]);
    assert.deepEqual(result.promptContracts, [
      "plan",
      "plan-verify",
      "plan-fix",
      "implement",
      "review",
      "supervise",
      "fix",
    ]);
  });

  it("keeps all phase visibility green when the fixture uses real bundled skills", async () => {
    const fixture = await copyFixture();
    await overlayBundledSkill(fixture, "autokit-implement");
    await overlayBundledSkill(fixture, "autokit-review");

    const result = await runRunnerVisibilitySelfTest(pathToFileURL(`${fixture}/`));

    assert.deepEqual(result.failures, []);
    assert.equal(result.passed, result.total);
  });

  it("keeps all phase visibility green when the fixture uses real bundled agents", async () => {
    const fixture = await copyFixture();
    for (const agent of [
      "planner",
      "plan-verifier",
      "implementer",
      "reviewer",
      "supervisor",
      "doc-updater",
    ] as const) {
      await overlayBundledAgent(fixture, agent);
    }

    const result = await runRunnerVisibilitySelfTest(pathToFileURL(`${fixture}/`));

    assert.deepEqual(result.failures, []);
    assert.equal(result.passed, result.total);
  });

  it("fails closed when .agents skills escape the fixture root", async () => {
    const fixture = await copyFixture();
    const external = await mkdtemp(join(tmpdir(), "autokit-runner-visibility-external-"));

    await cp(join(fixture, ".agents", "skills"), join(external, "skills"), {
      recursive: true,
    });
    await rm(join(fixture, ".agents", "skills"), { recursive: true });
    await symlink(join(external, "skills"), join(fixture, ".agents", "skills"));

    await assertSelfTestFailure(fixture, "claude skills symlink resolves into .agents");
  });

  it("fails closed when autokit-question is not the final resolver line", async () => {
    const fixture = await copyFixture();
    await writeFile(
      join(fixture, ".agents", "prompts", "plan.md"),
      [
        "# plan",
        "",
        "Use the bundled autokit-question skill for status=need_input responses.",
        "",
        "Produce the implementation plan for the fixed issue input.",
      ].join("\n"),
      "utf8",
    );

    await assertSelfTestFailure(fixture, "all prompts reference autokit-question exactly once");
  });

  it("fails closed when a phase skill is only mentioned as prose", async () => {
    const fixture = await copyFixture();
    await writeFile(
      join(fixture, ".agents", "prompts", "review.md"),
      [
        "# review",
        "",
        "Review the candidate PR and return structured findings.",
        "",
        "Mention autokit-review in prose without the resolver line.",
        "Use the bundled autokit-question skill for status=need_input responses.",
      ].join("\n"),
      "utf8",
    );

    await assertSelfTestFailure(
      fixture,
      "phase prompts reference only their expected bundled skills",
    );
  });

  it("fails closed when provider prompt directories exist as broken symlinks", async () => {
    const fixture = await copyFixture();
    await symlink("/nonexistent/autokit-prompts", join(fixture, ".claude", "prompts"));

    await assertSelfTestFailure(fixture, "claude provider prompt directory is absent");
  });

  it("fails closed when the fixed issue omits the default-answer scenario", async () => {
    const fixture = await copyFixture();
    await writeFile(
      join(fixture, "issue.md"),
      "AK-002-FIXTURE autokit-question status=need_input\n",
      "utf8",
    );

    await assertSelfTestFailure(
      fixture,
      "fixed issue input declares need_input default-answer scenario",
    );
  });
});

describe("prompt asset visibility gate", () => {
  it("keeps bundled skill assets aligned with prompt_contract fields and source pins", async () => {
    const result = await runSkillAssetQualityGate();

    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.skills, ["autokit-implement", "autokit-review"]);
    assert.deepEqual(result.checkedSkillAssets, [
      "base:skills/autokit-implement/SKILL.md",
      "preset:default/skills/autokit-implement/SKILL.md",
      "preset:docs-create/skills/autokit-implement/SKILL.md",
      "preset:laravel-filament/skills/autokit-implement/SKILL.md",
      "preset:next-shadcn/skills/autokit-implement/SKILL.md",
      "base:skills/autokit-review/SKILL.md",
      "preset:default/skills/autokit-review/SKILL.md",
      "preset:docs-create/skills/autokit-review/SKILL.md",
      "preset:laravel-filament/skills/autokit-review/SKILL.md",
      "preset:next-shadcn/skills/autokit-review/SKILL.md",
    ]);
    assert.deepEqual(result.sourcePins, {
      "autokit-implement": "866d9ebb5364a579ac7d2a8fb79bb421bf9d7052",
      "autokit-review": "b95eddbaa3e3c671c657084d8919a0a34d031dec60a6228d08158514a742d7f5",
    });
  });

  it("keeps bundled agent assets aligned with capability boundaries", async () => {
    const result = await runAgentAssetQualityGate();

    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.agents, [
      "planner",
      "plan-verifier",
      "implementer",
      "reviewer",
      "supervisor",
      "doc-updater",
    ]);
    assert.deepEqual(result.checkedAgentAssets, [
      "base:agents/planner.md",
      "base:agents/plan-verifier.md",
      "base:agents/implementer.md",
      "base:agents/reviewer.md",
      "base:agents/supervisor.md",
      "base:agents/doc-updater.md",
    ]);
  });

  it("fails closed when a bundled agent omits permission boundaries", async () => {
    const assetsRoot = await copyAssets();
    await writeFile(
      join(assetsRoot, "agents", "implementer.md"),
      ["# implementer", "", "Implement the assigned issue."].join("\n"),
      "utf8",
    );

    await assertAgentGateFailure(assetsRoot, "base:agents/implementer.md");
  });

  it("fails closed when an unexpected base agent asset is bundled", async () => {
    const assetsRoot = await copyAssets();
    await writeFile(
      join(assetsRoot, "agents", "security-reviewer.md"),
      ["# security-reviewer", "", "Unexpected future agent."].join("\n"),
      "utf8",
    );

    await assertAgentGateFailure(assetsRoot, "unexpected agent asset: security-reviewer.md");
  });

  it("fails closed when bundled agent sections are token-stuffed but empty", async () => {
    const assetsRoot = await copyAssets();
    await writeFile(
      join(assetsRoot, "agents", "implementer.md"),
      [
        "# implementer",
        "",
        "`implement` `fix` `write_worktree` assigned worktree Do not run git `data.changed_files` `data.tests_run` `data.docs_updated` `data.resolved_accept_ids`",
        "",
        "## Role",
        "Implement.",
        "",
        "## Do",
        "",
        "## Don't",
        "",
        "## Decision Rules",
        "",
        "## Permission Boundary",
        "",
        "## Source of Truth",
        "",
        "## AI Anti-Patterns",
        "",
        "## Output",
      ].join("\n"),
      "utf8",
    );

    await assertAgentGateFailure(assetsRoot, "invalid sections");
  });

  it("fails closed when a bundled skill omits prompt_contract fields", async () => {
    const assetsRoot = await copyAssets();
    await writeFile(
      join(assetsRoot, "skills", "autokit-implement", "SKILL.md"),
      [
        "---",
        "name: autokit-implement",
        "description: incomplete fixture",
        "---",
        "",
        "# autokit-implement",
        "",
        "Source alignment: tdd-workflow 866d9ebb5364a579ac7d2a8fb79bb421bf9d7052.",
        "Return the prompt_contract for `implement` and `fix`.",
      ].join("\n"),
      "utf8",
    );

    await assertSkillGateFailure(assetsRoot, "base:skills/autokit-implement");
  });

  it("fails closed when a bundled review skill suggests top-level findings", async () => {
    const assetsRoot = await copyAssets();
    const reviewPath = join(assetsRoot, "skills", "autokit-review", "SKILL.md");
    const reviewSkill = await readFile(reviewPath, "utf8");
    await writeFile(
      reviewPath,
      reviewSkill.replace(
        "`data.findings` must be an array",
        "`data.findings` / `findings` must be an array",
      ),
      "utf8",
    );

    await assertSkillGateFailure(assetsRoot, "must not contain");
  });

  it("keeps real bundled prompt assets mapped and marker-normalized", async () => {
    const result = await runPromptAssetVisibilityGate();

    assert.deepEqual(result.failures, []);
    assert.equal(result.promptFiles.length, 7);
    assert.deepEqual(result.markerSections, [
      "## Result",
      "## Evidence",
      "## Changes",
      "## Test results",
    ]);
    assert.equal(result.presetEffectivePrompts.length, 28);
    for (const preset of ["default", "laravel-filament", "next-shadcn", "docs-create"]) {
      assert.ok(result.presetEffectivePrompts.includes(`preset:${preset}/prompts/implement.md`));
      assert.ok(result.presetEffectivePrompts.includes(`preset:${preset}/prompts/review.md`));
    }
  });

  it("fails closed when a real prompt asset omits a required marker", async () => {
    const assetsRoot = await copyAssets();
    await writeFile(
      join(assetsRoot, "prompts", "plan.md"),
      [
        "# plan",
        "",
        "## Result",
        "## Changes",
        "## Test results",
        "",
        "Use skill: autokit-question",
      ].join("\n"),
      "utf8",
    );

    await assertPromptGateFailure(assetsRoot, "plan.md missing marker ## Evidence");
  });

  it("fails closed when prompt files are not represented by the mapping table", async () => {
    const assetsRoot = await copyAssets();
    await writeFile(
      join(assetsRoot, "prompts", "extra.md"),
      ["# extra", "", "## Result", "## Evidence", "## Changes", "## Test results"].join("\n"),
      "utf8",
    );

    await assertPromptGateFailure(assetsRoot, "unexpected prompt asset: extra");
  });

  it("fails closed when a bundled preset prompt override lacks mapping coverage", async () => {
    const assetsRoot = await copyAssets();
    const presetPromptDir = join(assetsRoot, "presets", "unmapped", "prompts");
    await mkdir(presetPromptDir, { recursive: true });
    await writeFile(
      join(presetPromptDir, "plan.md"),
      ["# plan", "", "## Result", "## Evidence", "## Changes", "## Test results"].join("\n"),
      "utf8",
    );

    await assertPromptGateFailure(
      assetsRoot,
      "mapping missing for preset:unmapped/prompts/plan.md ## Result",
    );
  });

  it("fails closed when a bundled preset prompt asset is nested outside the contract set", async () => {
    const assetsRoot = await copyAssets();
    const nestedPromptDir = join(assetsRoot, "presets", "default", "prompts", "nested");
    await mkdir(nestedPromptDir, { recursive: true });
    await writeFile(
      join(nestedPromptDir, "plan.md"),
      ["# plan", "", "## Result", "## Evidence", "## Changes", "## Test results"].join("\n"),
      "utf8",
    );

    await assertPromptGateFailure(
      assetsRoot,
      "unexpected preset prompt asset: default/prompts/nested/plan",
    );
  });
});

async function copyFixture(): Promise<string> {
  const destination = await mkdtemp(join(tmpdir(), "autokit-runner-visibility-"));
  await cp(fileURLToPath(FIXTURE_URL), destination, {
    recursive: true,
    verbatimSymlinks: true,
  });
  return destination;
}

async function copyAssets(): Promise<string> {
  const destination = await mkdtemp(join(tmpdir(), "autokit-prompt-assets-"));
  await cp(fileURLToPath(new URL("../../packages/cli/assets/", import.meta.url)), destination, {
    recursive: true,
    verbatimSymlinks: true,
  });
  return destination;
}

async function overlayBundledSkill(
  fixture: string,
  skill: "autokit-implement" | "autokit-review",
): Promise<void> {
  await rm(join(fixture, ".agents", "skills", skill), { recursive: true, force: true });
  await cp(
    fileURLToPath(new URL(`../../packages/cli/assets/skills/${skill}/`, import.meta.url)),
    join(fixture, ".agents", "skills", skill),
    {
      recursive: true,
      verbatimSymlinks: true,
    },
  );
}

async function overlayBundledAgent(
  fixture: string,
  agent: "planner" | "plan-verifier" | "implementer" | "reviewer" | "supervisor" | "doc-updater",
): Promise<void> {
  await cp(
    fileURLToPath(new URL(`../../packages/cli/assets/agents/${agent}.md`, import.meta.url)),
    join(fixture, ".agents", "agents", `${agent}.md`),
  );
}

async function assertPromptGateFailure(assetsRoot: string, expectedFailure: string): Promise<void> {
  const result = await runPromptAssetVisibilityGate({
    assetsRootUrl: pathToFileURL(`${assetsRoot}/`),
  });
  assert.notEqual(result.failures.length, 0);
  assert.ok(
    result.failures.some((failure) => failure.includes(expectedFailure)),
    `expected failure containing ${expectedFailure}, got ${result.failures.join("; ")}`,
  );
}

async function assertAgentGateFailure(assetsRoot: string, expectedFailure: string): Promise<void> {
  const result = await runAgentAssetQualityGate({
    assetsRootUrl: pathToFileURL(`${assetsRoot}/`),
  });
  assert.notEqual(result.failures.length, 0);
  assert.ok(
    result.failures.some((failure) => failure.includes(expectedFailure)),
    `expected failure containing ${expectedFailure}, got ${result.failures.join("; ")}`,
  );
}

async function assertSkillGateFailure(assetsRoot: string, expectedFailure: string): Promise<void> {
  const result = await runSkillAssetQualityGate({
    assetsRootUrl: pathToFileURL(`${assetsRoot}/`),
  });
  assert.notEqual(result.failures.length, 0);
  assert.ok(
    result.failures.some((failure) => failure.includes(expectedFailure)),
    `expected failure containing ${expectedFailure}, got ${result.failures.join("; ")}`,
  );
}

async function assertSelfTestFailure(fixture: string, expectedCheck: string): Promise<void> {
  const result = await runRunnerVisibilitySelfTest(pathToFileURL(`${fixture}/`));
  assert.notEqual(result.failures.length, 0);
  assert.ok(
    result.failures.some((failure) => failure.includes(expectedCheck)),
    `expected failure containing ${expectedCheck}, got ${result.failures.join("; ")}`,
  );
}
