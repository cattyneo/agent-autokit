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
    const e34Rows = [...extractSection(SPEC, "### 5.1", "### 5.2").matchAll(/^\| E34 \|.*$/gm)].map(
      (match) => match[0],
    );

    assert.equal(e34Rows.length, 1);
    assert.match(e34Rows[0] ?? "", /runtime\.phase_self_correct_done=true/);
    assert.match(e34Rows[0] ?? "", /failure\.code=prompt_contract_violation/);
  });
});

function extractSpecFailureCodes(spec: string): string[] {
  return sortStrings(
    [...extractSection(spec, "##### 4.2.1.1", "### 4.3").matchAll(/\| `([a-z_]+)` \|/g)].map(
      (match) => match[1],
    ),
  );
}

function extractSpecFailureAuditKinds(spec: string): string[] {
  return sortStrings(
    [...extractSection(spec, "##### 10.2.2.2", "### 10.3").matchAll(/^- `([a-z_]+)`/gm)].map(
      (match) => match[1],
    ),
  );
}

function extractSpecOperationalAuditKinds(spec: string): string[] {
  return sortStrings(
    [
      ...extractSection(spec, "##### 10.2.2.1", "##### 10.2.2.2").matchAll(/^\| `([a-z_]+)` \|/gm),
    ].map((match) => match[1]),
  );
}

function extractSection(spec: string, start: string, end: string): string {
  const startIndex = spec.indexOf(start);
  const endIndex = spec.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return spec.slice(startIndex, endIndex);
}

function sortStrings(values: string[]): string[] {
  return values.sort((left, right) => left.localeCompare(right));
}
