import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parsePromptContractYaml,
  promptContractForPhase,
  validatePromptContractPayload,
} from "./runner-contract.ts";

describe("runner prompt contract", () => {
  it("maps runtime phases to fixed prompt contracts", () => {
    assert.equal(promptContractForPhase("plan"), "plan");
    assert.equal(promptContractForPhase("plan_fix"), "plan-fix");
    assert.equal(promptContractForPhase("review"), "review");
    assert.equal(promptContractForPhase("supervise"), "supervise");
  });

  it("accepts completed Claude plan data and rejects unknown fields", () => {
    const result = validatePromptContractPayload("plan", {
      status: "completed",
      summary: "ok",
      data: {
        plan_markdown: "## Plan",
        assumptions: [],
        risks: [],
      },
    });
    assert.equal(result.ok, true);

    const drift = validatePromptContractPayload("plan", {
      status: "completed",
      summary: "ok",
      data: {
        plan_markdown: "## Plan",
        assumptions: [],
        risks: [],
        extra: true,
      },
    });
    assert.equal(drift.ok, false);
    assert.match(drift.errors.join("\n"), /data\.extra is not allowed/);
  });

  it("fail-closes need_input without a default answer", () => {
    const result = validatePromptContractPayload("review", {
      status: "need_input",
      summary: "question",
      question: {
        text: "Proceed?",
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /question\.default is required/);
  });

  it("parses YAML and validates paused data shape", () => {
    const result = parsePromptContractYaml(
      "supervise",
      [
        "status: paused",
        "summary: wait",
        "data:",
        "  reason: reviewer decision required",
        "  recoverable: true",
      ].join("\n"),
    );
    assert.equal(result.ok, true);
    assert.equal(result.payload.status, "paused");
  });

  it("requires supervise fix_prompt when findings are accepted", () => {
    const result = validatePromptContractPayload("supervise", {
      status: "completed",
      summary: "supervise",
      data: {
        accept_ids: ["finding-1"],
        reject_ids: [],
        reject_reasons: {},
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /fix_prompt is required/);
  });

  it("validates review finding shape and repo-relative files", () => {
    const valid = validatePromptContractPayload("review", {
      status: "completed",
      summary: "review",
      data: {
        findings: [
          {
            severity: "P1",
            file: "packages/core/src/index.ts",
            line: 12,
            title: "Contract issue",
            rationale: "The contract should be strict.",
            suggested_fix: "Tighten validation.",
          },
        ],
      },
    });
    assert.equal(valid.ok, true);

    const invalid = validatePromptContractPayload("review", {
      status: "completed",
      summary: "review",
      data: {
        findings: [
          {
            severity: "P9",
            file: "/etc/passwd",
            line: 0,
            title: "Bad",
            rationale: "Bad",
            suggested_fix: "Bad",
            extra: true,
          },
        ],
      },
    });
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors.join("\n"), /severity must be P0, P1, P2, or P3/);
    assert.match(invalid.errors.join("\n"), /file must be a repo-relative path/);
    assert.match(invalid.errors.join("\n"), /line must be a positive integer or null/);
    assert.match(invalid.errors.join("\n"), /extra is not allowed/);
  });
});
