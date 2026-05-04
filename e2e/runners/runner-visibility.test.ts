import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runRunnerVisibilitySelfTest } from "./runner-visibility.ts";

describe("runner visibility spike fixtures", () => {
  it("keeps provider-visible skills and agents rooted in .agents", async () => {
    const result = await runRunnerVisibilitySelfTest(
      new URL("../fixtures/runner-visibility/", import.meta.url),
    );

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
});
