import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildRunnerEnv } from "../../packages/core/src/env-allowlist.ts";
import {
  failureAuditKinds,
  failureCodes,
  operationalAuditKinds,
} from "../../packages/core/src/logger.ts";
import {
  extractSpecE34Rows,
  extractSpecFailureAuditKinds,
  extractSpecFailureCodes,
  extractSpecOperationalAuditKinds,
  sortStrings,
} from "../../packages/core/src/spec-trace.ts";

const SPEC = readFileSync("docs/SPEC.md", "utf8");

const REQUIRED_V02_OPERATIONAL_AUDIT_KINDS = [
  "effort_downgrade",
  "phase_self_correct",
  "phase_override_started",
  "phase_override_ended",
  "serve_lock_busy",
  "preset_apply_started",
  "preset_apply_finished",
  "preset_apply_rollback_started",
  "preset_apply_rollback_finished",
  "preset_apply_rollback_failed",
];

describe("Issue #117 SPEC trace gate", () => {
  it("runs the shell trace gate through the active test runner", () => {
    const result = spawnSync("/bin/bash", ["scripts/check-trace.sh"], {
      cwd: process.cwd(),
      env: buildRunnerEnv(process.env),
      encoding: "utf8",
    });

    assert.equal(
      result.status,
      0,
      [
        "$ bash scripts/check-trace.sh",
        `status: ${String(result.status)}`,
        result.stdout,
        result.stderr,
      ].join("\n"),
    );
    assert.match(result.stdout, /traceability checks passed/);
  });

  it("keeps failure codes and failure audit kinds exactly aligned with SPEC", () => {
    const specFailureCodes = extractSpecFailureCodes(SPEC);
    const specFailureAuditKinds = extractSpecFailureAuditKinds(SPEC);

    assert.deepEqual(sortStrings([...failureCodes]), specFailureCodes);
    assert.deepEqual(sortStrings([...failureAuditKinds]), specFailureAuditKinds);
    assert.deepEqual(specFailureCodes, specFailureAuditKinds);
    assert.equal(failureAuditKinds, failureCodes);
  });

  it("keeps operational audit kinds exactly aligned with SPEC", () => {
    const specOperationalAuditKinds = extractSpecOperationalAuditKinds(SPEC);

    assert.deepEqual(sortStrings([...operationalAuditKinds]), specOperationalAuditKinds);
    for (const kind of REQUIRED_V02_OPERATIONAL_AUDIT_KINDS) {
      assert.ok(
        specOperationalAuditKinds.includes(kind),
        `missing SPEC operational audit kind: ${kind}`,
      );
      assert.ok(
        operationalAuditKinds.includes(kind),
        `missing implementation operational audit kind: ${kind}`,
      );
    }
  });

  it("keeps the E34 prompt-contract condition tied to self-correction state", () => {
    const e34Rows = extractSpecE34Rows(SPEC);

    assert.equal(e34Rows.length, 1);
    assert.match(e34Rows[0] ?? "", /runtime\.phase_self_correct_done=true/);
    assert.match(e34Rows[0] ?? "", /failure\.code=prompt_contract_violation/);
  });
});
