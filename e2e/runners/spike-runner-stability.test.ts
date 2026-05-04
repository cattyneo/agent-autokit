import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCodexSmokeCommand,
  runPromptContractSelfTest,
  validatePromptContract,
} from "./spike-runner-stability.ts";

describe("prompt_contract fixture validation", () => {
  it("matches each fixture expectation and fails closed for invalid contracts", async () => {
    const result = await runPromptContractSelfTest(
      new URL("../fixtures/prompt-contract/", import.meta.url),
    );

    assert.equal(result.total, 19);
    assert.equal(result.passedExpectations, 19);
    assert.equal(result.failClosedCount, 8);
    assert.deepEqual(result.failures, []);
  });

  it("rejects unknown top-level fields", () => {
    const result = validatePromptContract("plan", {
      status: "completed",
      summary: "Plan created",
      extra: true,
      data: {
        plan_markdown: "## Plan",
        assumptions: [],
        risks: [],
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "prompt_contract_violation");
  });

  it("can build a pinned Codex npx smoke command", () => {
    const previousPackage = process.env.AUTOKIT_CODEX_NPX_PACKAGE;
    const previousNpx = process.env.AUTOKIT_NPX_BIN;
    process.env.AUTOKIT_CODEX_NPX_PACKAGE = "@openai/codex@0.128.0";
    process.env.AUTOKIT_NPX_BIN = "npx";

    try {
      const command = buildCodexSmokeCommand("/tmp/schema.json");

      assert.equal(command.command, "npx");
      assert.deepEqual(command.args.slice(0, 3), ["-y", "@openai/codex@0.128.0", "-a"]);
      assert.ok(command.args.includes("--output-schema"));
      assert.ok(command.args.includes("/tmp/schema.json"));
    } finally {
      restoreEnv("AUTOKIT_CODEX_NPX_PACKAGE", previousPackage);
      restoreEnv("AUTOKIT_NPX_BIN", previousNpx);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
