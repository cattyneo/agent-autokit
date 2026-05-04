import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfigYaml } from "./config.ts";
import {
  createEmptyResolvedModels,
  ModelResolutionError,
  resolveModelsForPlanning,
} from "./model-resolver.ts";

describe("core model resolver", () => {
  it("resolves all model:auto phases once when entering planning", () => {
    const config = parseConfigYaml("version: 1\n");
    const calls: string[] = [];

    const resolved = resolveModelsForPlanning(config, {
      resolveAutoModel: (phase, phaseConfig) => {
        calls.push(`${phase}:${phaseConfig.provider}`);
        return `${phaseConfig.provider}:${phase}`;
      },
    });

    assert.deepEqual(resolved, {
      plan: "claude:plan",
      plan_verify: "codex:plan_verify",
      plan_fix: "claude:plan_fix",
      implement: "codex:implement",
      review: "claude:review",
      supervise: "claude:supervise",
      fix: "codex:fix",
    });
    assert.deepEqual(calls, [
      "plan:claude",
      "plan_verify:codex",
      "plan_fix:claude",
      "implement:codex",
      "review:claude",
      "supervise:claude",
      "fix:codex",
    ]);
  });

  it("preserves explicit model pins without calling the auto resolver", () => {
    const config = parseConfigYaml(`
version: 1
phases:
  plan:
    model: claude-pinned
  implement:
    model: codex-pinned
`);

    const resolved = resolveModelsForPlanning(config, {
      resolveAutoModel: (phase) => `${phase}:auto`,
    });

    assert.equal(resolved.plan, "claude-pinned");
    assert.equal(resolved.implement, "codex-pinned");
    assert.equal(resolved.review, "review:auto");
  });

  it("reuses previously resolved models on resume without re-resolving", () => {
    const config = parseConfigYaml("version: 1\n");
    const existing = createEmptyResolvedModels();
    existing.plan = "already-resolved-plan";
    existing.fix = "already-resolved-fix";

    const resolved = resolveModelsForPlanning(config, {
      existing,
      resolveAutoModel: (phase) => `${phase}:new`,
    });

    assert.equal(resolved.plan, "already-resolved-plan");
    assert.equal(resolved.fix, "already-resolved-fix");
    assert.equal(resolved.review, "review:new");
  });

  it("fails closed when model:auto is present but no resolver is available", () => {
    const config = parseConfigYaml("version: 1\n");

    assert.throws(() => resolveModelsForPlanning(config), ModelResolutionError);
  });

  it("rejects empty resolver output", () => {
    const config = parseConfigYaml("version: 1\n");

    assert.throws(
      () =>
        resolveModelsForPlanning(config, {
          resolveAutoModel: () => " ",
        }),
      ModelResolutionError,
    );
  });
});
