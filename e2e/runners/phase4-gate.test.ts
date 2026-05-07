import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runPhase4CompletionGate } from "./phase4-gate.ts";

describe("Phase 4 E2E gate", () => {
  it("observes prompt, skill, agent, schema, self-correction, and integration gates without live providers", async () => {
    const result = await runPhase4CompletionGate();

    assert.deepEqual(result.assetGateFailures, []);
    assert.deepEqual(result.payloadContracts, [
      "plan",
      "plan-verify",
      "plan-fix",
      "implement",
      "review",
      "supervise",
      "fix",
    ]);
    assert.deepEqual(result.schemaContracts, result.payloadContracts);
    assert.deepEqual(result.workflowPhases, [
      "plan",
      "plan",
      "plan_verify",
      "plan_fix",
      "plan_verify",
      "implement",
      "review",
      "supervise",
      "fix",
      "review",
    ]);
    assert.deepEqual(result.workflowProviders, [
      "claude",
      "claude",
      "codex",
      "claude",
      "codex",
      "codex",
      "claude",
      "claude",
      "codex",
      "claude",
    ]);
    assert.deepEqual(result.workflowPromptContracts, [
      "plan",
      "plan",
      "plan-verify",
      "plan-fix",
      "plan-verify",
      "implement",
      "review",
      "supervise",
      "fix",
      "review",
    ]);
    assert.equal(result.selfCorrectionCount, 1);
    assert.equal(result.finalTaskState, "merged");
    assert.deepEqual(result.providerSubprocessCommands, []);
    assert.ok(
      result.commands.includes("gh pr merge 110 --auto --rebase --match-head-commit fix-head"),
    );
  });

  it("fails closed when runtime prompt assets are not injected into runner prompts", async () => {
    await assert.rejects(
      () =>
        runPhase4CompletionGate({
          mutateRepo: (repo) => rmSync(join(repo, ".agents", "prompts", "plan-fix.md")),
        }),
      /plan-fix prompt asset exists/,
    );
  });
});
