import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveEffort } from "./effort-resolver.ts";

describe("core effort resolver", () => {
  it("resolves supported effort tuples without audit", () => {
    const result = resolveEffort({
      phase: "implement",
      provider: "codex",
      effort: "medium",
      model: "gpt-5.5",
      unsupported_policy: "fail",
      timeout_ms: 1_800_000,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.resolved : null, {
      phase: "implement",
      provider: "codex",
      effort: "medium",
      downgraded_from: null,
      timeout_ms: 1_800_000,
    });
    assert.equal(result.ok ? result.audit : null, null);
  });

  it("fails or downgrades unsupported tuples according to policy", () => {
    const unsupported = {
      phase: "implement" as const,
      provider: "codex" as const,
      effort: "high" as const,
      model: "gpt-5.4-mini",
      timeout_ms: 3_600_000,
    };

    const failed = resolveEffort({ ...unsupported, unsupported_policy: "fail" });
    assert.equal(failed.ok, false);
    assert.equal(failed.ok ? null : failed.failure.code, "effort_unsupported");
    assert.match(failed.ok ? "" : failed.failure.message, /effort=high provider=codex/);

    const downgraded = resolveEffort({ ...unsupported, unsupported_policy: "downgrade" });
    assert.equal(downgraded.ok, true);
    assert.deepEqual(downgraded.ok ? downgraded.resolved : null, {
      phase: "implement",
      provider: "codex",
      effort: "medium",
      downgraded_from: "high",
      timeout_ms: 3_600_000,
    });
    assert.deepEqual(downgraded.ok ? downgraded.audit : null, {
      kind: "effort_downgrade",
      phase: "implement",
      provider: "codex",
      model: "gpt-5.4-mini",
      from: "high",
      to: "medium",
    });
  });
});
