import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runPromptContractSelfTest,
  validatePromptContract,
} from "./spike-runner-stability.ts";

describe("prompt_contract fixture validation", () => {
  it("matches each fixture expectation and fails closed for invalid contracts", async () => {
    const result = await runPromptContractSelfTest(
      new URL("../fixtures/prompt-contract/", import.meta.url),
    );

    assert.equal(result.total, 5);
    assert.equal(result.passedExpectations, 5);
    assert.equal(result.failClosedCount, 2);
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
});
