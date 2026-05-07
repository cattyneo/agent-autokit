import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runPromptAssetVisibilityGate, runRunnerVisibilitySelfTest } from "./runner-visibility.ts";

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
    const presetPromptDir = join(assetsRoot, "presets", "default", "prompts");
    await mkdir(presetPromptDir, { recursive: true });
    await writeFile(
      join(presetPromptDir, "plan.md"),
      ["# plan", "", "## Result", "## Evidence", "## Changes", "## Test results"].join("\n"),
      "utf8",
    );

    await assertPromptGateFailure(
      assetsRoot,
      "mapping missing for preset:default/prompts/plan.md ## Result",
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

async function assertSelfTestFailure(fixture: string, expectedCheck: string): Promise<void> {
  const result = await runRunnerVisibilitySelfTest(pathToFileURL(`${fixture}/`));
  assert.notEqual(result.failures.length, 0);
  assert.ok(
    result.failures.some((failure) => failure.includes(expectedCheck)),
    `expected failure containing ${expectedCheck}, got ${result.failures.join("; ")}`,
  );
}
