import { posix } from "node:path";

import { parseDocument } from "yaml";

import type { ClaudePermission, CodexPermission, PermissionProfile } from "./capability.js";

import {
  type PromptContractId,
  type Provider,
  phasePromptContracts,
  type RuntimePhase,
} from "./config.js";
import type { ResolvedEffort } from "./effort-resolver.js";

export type EffectivePermission = {
  permission_profile: PermissionProfile;
  claude?: ClaudePermission;
  codex?: CodexPermission;
};

export type AgentRunStatus = "completed" | "need_input" | "paused" | "rate_limited" | "failed";

export type AgentRunInput = {
  provider: Provider;
  phase: RuntimePhase;
  cwd: string;
  prompt: string;
  promptContract: PromptContractId;
  model: "auto" | string;
  effort?: ResolvedEffort;
  effective_permission?: EffectivePermission;
  resume?: {
    claudeSessionId?: string;
    codexSessionId?: string;
  };
  questionResponse?: PromptContractQuestion & {
    answer: string;
  };
  permissions: {
    mode: "auto" | "readonly" | "workspace-write";
    allowNetwork: boolean;
    workspaceScope?: "repo" | "worktree";
    workspaceRoot?: string;
  };
  timeoutMs: number;
};

export const QUESTION_RESPONSE_STRING_LIMIT = 16 * 1024;

export type PromptContractQuestion = {
  text: string;
  default: string;
};

export type PromptContractData = Record<string, unknown>;

export type AgentRunOutput = {
  status: AgentRunStatus;
  session?: {
    claudeSessionId?: string;
    codexSessionId?: string;
  };
  resolvedModel?: string;
  summary: string;
  structured?: PromptContractData;
  question?: PromptContractQuestion;
};

export type PromptContractValidationResult =
  | { ok: true; payload: ValidPromptContractPayload }
  | { ok: false; errors: string[] };

export type ValidPromptContractPayload = {
  status: Exclude<AgentRunStatus, "rate_limited">;
  summary: string;
  data?: PromptContractData;
  question?: PromptContractQuestion;
};

const STRING_LIMIT = 16 * 1024;
const PROMPT_CONTRACTS = new Set<PromptContractId>([
  "plan",
  "plan-verify",
  "plan-fix",
  "implement",
  "review",
  "supervise",
  "fix",
]);
const STATUSES = new Set(["completed", "need_input", "paused", "failed"]);

export function validatePromptContractPayload(
  contract: PromptContractId,
  payload: unknown,
): PromptContractValidationResult {
  const errors: string[] = [];

  if (!PROMPT_CONTRACTS.has(contract)) {
    return { ok: false, errors: [`unknown contract: ${contract}`] };
  }
  if (!isRecord(payload)) {
    return { ok: false, errors: ["payload must be an object"] };
  }

  rejectUnknownKeys(payload, new Set(["status", "summary", "data", "question"]), "payload", errors);

  if (!STATUSES.has(String(payload.status))) {
    errors.push("status must be completed, need_input, paused, or failed");
  }
  requireBoundedString(payload.summary, "summary", STRING_LIMIT, errors);

  if (payload.status === "completed") {
    if (!("data" in payload)) {
      errors.push("completed status requires data");
    } else {
      validateCompletedData(contract, payload.data, errors);
    }
    if ("question" in payload) {
      errors.push("completed status must not include question");
    }
  }

  if (payload.status === "need_input") {
    validateQuestion(payload.question, errors);
    if ("data" in payload) {
      validateCompletedData(contract, payload.data, errors);
    }
  }

  if (payload.status === "paused" || payload.status === "failed") {
    validatePausedOrFailedData(payload.data, errors);
    if ("question" in payload) {
      errors.push(`${payload.status} status must not include question`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const result: ValidPromptContractPayload = {
    status: payload.status as ValidPromptContractPayload["status"],
    summary: payload.summary as string,
  };
  if ("data" in payload && payload.data !== undefined) {
    result.data = payload.data as PromptContractData;
  }
  if ("question" in payload && isRecord(payload.question)) {
    result.question = {
      text: payload.question.text as string,
      default: payload.question.default as string,
    };
  }
  return { ok: true, payload: result };
}

export function parsePromptContractYaml(
  contract: PromptContractId,
  yamlText: string,
): PromptContractValidationResult {
  const document = parseDocument(yamlText, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return { ok: false, errors: document.errors.map((error) => error.message) };
  }
  return validatePromptContractPayload(contract, document.toJSON());
}

export function promptContractForPhase(phase: RuntimePhase): PromptContractId {
  return phasePromptContracts[phase];
}

export function promptContractJsonSchema(contract: PromptContractId): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed", "need_input", "paused", "failed"] },
      summary: { type: "string", maxLength: STRING_LIMIT },
      data: dataJsonSchemaFor(contract),
      question: {
        type: "object",
        properties: {
          text: { type: "string", maxLength: STRING_LIMIT },
          default: { type: "string", maxLength: STRING_LIMIT },
        },
        required: ["text", "default"],
        additionalProperties: false,
      },
    },
    required: ["status", "summary"],
    additionalProperties: false,
  };
}

export function formatQuestionResponsePrompt(input: AgentRunInput): string {
  if (input.questionResponse === undefined) {
    return input.prompt;
  }
  assertBoundedQuestionResponse(input.questionResponse);
  const envelope = {
    autokit_need_input_response: {
      question: {
        text: input.questionResponse.text,
        default: input.questionResponse.default,
      },
      answer: input.questionResponse.answer,
    },
  };
  return [
    input.prompt,
    "",
    "Use the following JSON as the answer to the pending autokit need_input question.",
    JSON.stringify(envelope),
    "Continue the resumed turn and return structured output only.",
  ].join("\n");
}

function assertBoundedQuestionResponse(
  response: NonNullable<AgentRunInput["questionResponse"]>,
): void {
  requireBoundedQuestionResponseString(response.text, "questionResponse.text");
  requireBoundedQuestionResponseString(response.default, "questionResponse.default");
  requireBoundedQuestionResponseString(response.answer, "questionResponse.answer");
}

function requireBoundedQuestionResponseString(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > QUESTION_RESPONSE_STRING_LIMIT
  ) {
    throw new Error(
      `${field} must be a non-empty string up to ${QUESTION_RESPONSE_STRING_LIMIT} chars`,
    );
  }
}

function dataJsonSchemaFor(contract: PromptContractId): Record<string, unknown> {
  switch (contract) {
    case "plan":
      return objectSchema({
        plan_markdown: { type: "string", maxLength: 64 * 1024 },
        assumptions: stringArraySchema(20),
        risks: stringArraySchema(20),
      });
    case "plan-verify":
      return objectSchema({
        result: { type: "string", enum: ["ok", "ng"] },
        findings: { type: "array", items: planVerifyFindingJsonSchema(), maxItems: 20 },
      });
    case "plan-fix":
      return objectSchema({
        plan_markdown: { type: "string", maxLength: 64 * 1024 },
        addressed_findings: stringArraySchema(20),
      });
    case "implement":
      return objectSchema({
        changed_files: stringArraySchema(200),
        tests_run: testEvidenceArraySchema(),
        docs_updated: { type: "boolean" },
        notes: { type: "string", maxLength: STRING_LIMIT },
      });
    case "review":
      return objectSchema({
        findings: { type: "array", items: reviewFindingJsonSchema(), maxItems: 50 },
      });
    case "supervise":
      return objectSchema({
        accept_ids: stringArraySchema(50),
        reject_ids: stringArraySchema(50),
        reject_reasons: { type: "object", additionalProperties: { type: "string" } },
        fix_prompt: { type: "string", maxLength: 32 * 1024 },
      });
    case "fix":
      return objectSchema({
        changed_files: stringArraySchema(200),
        tests_run: testEvidenceArraySchema(),
        resolved_accept_ids: stringArraySchema(50),
        unresolved_accept_ids: stringArraySchema(50),
        notes: { type: "string", maxLength: STRING_LIMIT },
      });
  }
}

function validateCompletedData(contract: PromptContractId, data: unknown, errors: string[]): void {
  switch (contract) {
    case "plan":
      validateRecordWithKeys(data, ["plan_markdown", "assumptions", "risks"], "data", errors);
      if (!isRecord(data)) {
        return;
      }
      requireBoundedString(data.plan_markdown, "data.plan_markdown", 64 * 1024, errors);
      requireStringArray(data.assumptions, "data.assumptions", 20, errors);
      requireStringArray(data.risks, "data.risks", 20, errors);
      return;
    case "plan-verify":
      validateRecordWithKeys(data, ["result", "findings"], "data", errors);
      if (!isRecord(data)) {
        return;
      }
      if (data.result !== "ok" && data.result !== "ng") {
        errors.push("data.result must be ok or ng");
      }
      validatePlanVerifyFindings(data.findings, errors);
      if (data.result === "ok" && Array.isArray(data.findings) && data.findings.length > 0) {
        errors.push("data.findings must be empty when data.result is ok");
      }
      return;
    case "plan-fix":
      validateRecordWithKeys(data, ["plan_markdown", "addressed_findings"], "data", errors);
      if (!isRecord(data)) {
        return;
      }
      requireBoundedString(data.plan_markdown, "data.plan_markdown", 64 * 1024, errors);
      requireStringArray(data.addressed_findings, "data.addressed_findings", 20, errors);
      return;
    case "implement":
      validateRecordWithKeys(
        data,
        ["changed_files", "tests_run", "docs_updated", "notes"],
        "data",
        errors,
      );
      if (!isRecord(data)) {
        return;
      }
      requireStringArray(data.changed_files, "data.changed_files", 200, errors);
      requireTestEvidenceArray(data.tests_run, errors);
      if (typeof data.docs_updated !== "boolean") {
        errors.push("data.docs_updated must be boolean");
      }
      requireBoundedString(data.notes, "data.notes", STRING_LIMIT, errors);
      return;
    case "review":
      validateRecordWithKeys(data, ["findings"], "data", errors);
      if (!isRecord(data)) {
        return;
      }
      validateReviewFindings(data.findings, errors);
      return;
    case "supervise":
      validateRecordWithKeys(data, ["accept_ids", "reject_ids", "reject_reasons"], "data", errors, [
        "fix_prompt",
      ]);
      if (!isRecord(data)) {
        return;
      }
      requireStringArray(data.accept_ids, "data.accept_ids", 50, errors);
      requireStringArray(data.reject_ids, "data.reject_ids", 50, errors);
      requireNoDuplicateStrings(data.accept_ids, "data.accept_ids", errors);
      requireNoDuplicateStrings(data.reject_ids, "data.reject_ids", errors);
      requireDisjointStringArrays(
        data.accept_ids,
        "data.accept_ids",
        data.reject_ids,
        "data.reject_ids",
        errors,
      );
      if (!isRecord(data.reject_reasons)) {
        errors.push("data.reject_reasons must be an object");
      } else {
        for (const [key, value] of Object.entries(data.reject_reasons)) {
          requireBoundedString(key, "data.reject_reasons key", STRING_LIMIT, errors);
          requireBoundedString(value, `data.reject_reasons.${key}`, STRING_LIMIT, errors);
        }
      }
      if (Array.isArray(data.accept_ids) && data.accept_ids.length > 0 && !("fix_prompt" in data)) {
        errors.push("data.fix_prompt is required when data.accept_ids is non-empty");
      }
      if ("fix_prompt" in data) {
        requireBoundedString(data.fix_prompt, "data.fix_prompt", 32 * 1024, errors);
      }
      return;
    case "fix":
      validateRecordWithKeys(
        data,
        ["changed_files", "tests_run", "resolved_accept_ids", "unresolved_accept_ids", "notes"],
        "data",
        errors,
      );
      if (!isRecord(data)) {
        return;
      }
      requireStringArray(data.changed_files, "data.changed_files", 200, errors);
      requireTestEvidenceArray(data.tests_run, errors);
      requireStringArray(data.resolved_accept_ids, "data.resolved_accept_ids", 50, errors);
      requireStringArray(data.unresolved_accept_ids, "data.unresolved_accept_ids", 50, errors);
      requireNoDuplicateStrings(data.resolved_accept_ids, "data.resolved_accept_ids", errors);
      requireNoDuplicateStrings(data.unresolved_accept_ids, "data.unresolved_accept_ids", errors);
      requireDisjointStringArrays(
        data.resolved_accept_ids,
        "data.resolved_accept_ids",
        data.unresolved_accept_ids,
        "data.unresolved_accept_ids",
        errors,
      );
      requireBoundedString(data.notes, "data.notes", STRING_LIMIT, errors);
      return;
  }
}

function validateQuestion(question: unknown, errors: string[]): void {
  validateRecordWithKeys(question, ["text", "default"], "question", errors);
  if (!isRecord(question)) {
    return;
  }
  requireBoundedString(question.text, "question.text", STRING_LIMIT, errors);
  requireBoundedString(question.default, "question.default", STRING_LIMIT, errors);
}

function validatePausedOrFailedData(data: unknown, errors: string[]): void {
  validateRecordWithKeys(data, ["reason"], "data", errors, ["recoverable"]);
  if (!isRecord(data)) {
    return;
  }
  requireBoundedString(data.reason, "data.reason", STRING_LIMIT, errors);
  if ("recoverable" in data && typeof data.recoverable !== "boolean") {
    errors.push("data.recoverable must be boolean");
  }
}

function requireTestEvidenceArray(value: unknown, errors: string[]): void {
  const items = requireArray(value, "data.tests_run", 20, errors);
  if (items === undefined) {
    return;
  }
  for (const [index, item] of items.entries()) {
    validateRecordWithKeys(
      item,
      ["command", "result", "summary"],
      `data.tests_run[${index}]`,
      errors,
    );
    if (!isRecord(item)) {
      continue;
    }
    requireBoundedString(item.command, `data.tests_run[${index}].command`, STRING_LIMIT, errors);
    if (item.result !== "passed" && item.result !== "failed" && item.result !== "skipped") {
      errors.push(`data.tests_run[${index}].result must be passed, failed, or skipped`);
    }
    requireBoundedString(item.summary, `data.tests_run[${index}].summary`, STRING_LIMIT, errors);
  }
}

function validatePlanVerifyFindings(value: unknown, errors: string[]): void {
  const items = requireArray(value, "data.findings", 20, errors);
  if (items === undefined) {
    return;
  }
  for (const [index, item] of items.entries()) {
    const path = `data.findings[${index}]`;
    validateRecordWithKeys(
      item,
      ["severity", "title", "rationale", "required_change"],
      path,
      errors,
    );
    if (!isRecord(item)) {
      continue;
    }
    if (item.severity !== "blocker" && item.severity !== "major" && item.severity !== "minor") {
      errors.push(`${path}.severity must be blocker, major, or minor`);
    }
    requireBoundedString(item.title, `${path}.title`, STRING_LIMIT, errors);
    requireBoundedString(item.rationale, `${path}.rationale`, STRING_LIMIT, errors);
    requireBoundedString(item.required_change, `${path}.required_change`, STRING_LIMIT, errors);
  }
}

function validateReviewFindings(value: unknown, errors: string[]): void {
  const items = requireArray(value, "data.findings", 50, errors);
  if (items === undefined) {
    return;
  }
  for (const [index, item] of items.entries()) {
    const path = `data.findings[${index}]`;
    validateRecordWithKeys(
      item,
      ["severity", "file", "line", "title", "rationale", "suggested_fix"],
      path,
      errors,
    );
    if (!isRecord(item)) {
      continue;
    }
    if (
      item.severity !== "P0" &&
      item.severity !== "P1" &&
      item.severity !== "P2" &&
      item.severity !== "P3"
    ) {
      errors.push(`${path}.severity must be P0, P1, P2, or P3`);
    }
    requireRepoRelativePath(item.file, `${path}.file`, errors);
    if (item.line !== null && (!Number.isInteger(item.line) || Number(item.line) < 1)) {
      errors.push(`${path}.line must be a positive integer or null`);
    }
    requireBoundedString(item.title, `${path}.title`, STRING_LIMIT, errors);
    requireBoundedString(item.rationale, `${path}.rationale`, STRING_LIMIT, errors);
    requireBoundedString(item.suggested_fix, `${path}.suggested_fix`, STRING_LIMIT, errors);
  }
}

function validateRecordWithKeys(
  value: unknown,
  requiredKeys: string[],
  path: string,
  errors: string[],
  optionalKeys: string[] = [],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  rejectUnknownKeys(value, allowedKeys, path, errors);
  for (const key of requiredKeys) {
    if (!(key in value)) {
      errors.push(`${path}.${key} is required`);
    }
  }
}

function requireBoundedString(value: unknown, path: string, limit: number, errors: string[]): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return;
  }
  if (value.length > limit) {
    errors.push(`${path} exceeds ${limit} characters`);
  }
}

function requireStringArray(
  value: unknown,
  path: string,
  maxItems: number,
  errors: string[],
): void {
  const items = requireArray(value, path, maxItems, errors);
  if (items === undefined) {
    return;
  }
  for (const [index, item] of items.entries()) {
    requireBoundedString(item, `${path}[${index}]`, STRING_LIMIT, errors);
  }
}

function requireNoDuplicateStrings(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    return;
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    if (seen.has(item)) {
      errors.push(`${path} must not contain duplicate values`);
      return;
    }
    seen.add(item);
  }
}

function requireDisjointStringArrays(
  left: unknown,
  leftPath: string,
  right: unknown,
  rightPath: string,
  errors: string[],
): void {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return;
  }
  const rightValues = new Set(right.filter((item): item is string => typeof item === "string"));
  for (const item of left) {
    if (typeof item === "string" && rightValues.has(item)) {
      errors.push(`${leftPath} and ${rightPath} must be disjoint`);
      return;
    }
  }
}

function requireRepoRelativePath(value: unknown, path: string, errors: string[]): void {
  requireBoundedString(value, path, STRING_LIMIT, errors);
  if (typeof value !== "string") {
    return;
  }
  if (value.startsWith("/") || value.startsWith("~") || value.includes("\0")) {
    errors.push(`${path} must be a repo-relative path`);
    return;
  }
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    errors.push(`${path} must stay inside the repo`);
  }
}

function requireArray(
  value: unknown,
  path: string,
  maxItems: number,
  errors: string[],
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return undefined;
  }
  if (value.length > maxItems) {
    errors.push(`${path} exceeds ${maxItems} items`);
  }
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: Set<string>,
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${path}.${key} is not allowed`);
    }
  }
}

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function planVerifyFindingJsonSchema(): Record<string, unknown> {
  return objectSchema({
    severity: { type: "string", enum: ["blocker", "major", "minor"] },
    title: { type: "string", maxLength: STRING_LIMIT },
    rationale: { type: "string", maxLength: STRING_LIMIT },
    required_change: { type: "string", maxLength: STRING_LIMIT },
  });
}

function reviewFindingJsonSchema(): Record<string, unknown> {
  return objectSchema({
    severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
    file: { type: "string", maxLength: STRING_LIMIT, pattern: "^(?!/|~|\\.\\.?($|/)).+" },
    line: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    title: { type: "string", maxLength: STRING_LIMIT },
    rationale: { type: "string", maxLength: STRING_LIMIT },
    suggested_fix: { type: "string", maxLength: STRING_LIMIT },
  });
}

function stringArraySchema(maxItems: number): Record<string, unknown> {
  return { type: "array", items: { type: "string", maxLength: STRING_LIMIT }, maxItems };
}

function testEvidenceArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    items: objectSchema({
      command: { type: "string", maxLength: STRING_LIMIT },
      result: { type: "string", enum: ["passed", "failed", "skipped"] },
      summary: { type: "string", maxLength: STRING_LIMIT },
    }),
    maxItems: 20,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
