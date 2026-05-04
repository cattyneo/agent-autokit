import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  type AgentRunInput,
  type AgentRunOutput,
  type AutokitConfig,
  cloneTask,
  DEFAULT_CONFIG,
  type FailureCode,
  failureCodes,
  makeFailure,
  type PromptContractData,
  promptContractForPhase,
  type RuntimePhase,
  type TaskEntry,
  transitionTask,
} from "@cattyneo/autokit-core";

export const WORKFLOWS_PACKAGE = "@cattyneo/autokit-workflows";

export type WorkflowRunner = (input: AgentRunInput) => Promise<AgentRunOutput>;

export type WorkflowPromptInput = {
  task: TaskEntry;
  phase: RuntimePhase;
  currentFindings?: ReviewFindingWithId[];
};

export type WorkflowOptions = {
  runner: WorkflowRunner;
  repoRoot: string;
  worktreeRoot?: string;
  timeoutMs?: number;
  config?: AutokitConfig;
  resolvedModels?: Record<string, string>;
  buildPrompt?: (input: WorkflowPromptInput) => string;
  now?: () => string;
};

export type WorkflowResult = {
  task: TaskEntry;
};

export type PlanningWorkflowResult = WorkflowResult & {
  planMarkdown?: string;
  verifierFindings: PlanVerifyFinding[];
};

export type ReviewWorkflowResult = WorkflowResult & {
  findings: ReviewFindingWithId[];
  acceptedIds: string[];
  rejectedIds: string[];
  fixPrompt?: string;
};

export type PlanVerifyFinding = {
  severity: "blocker" | "major" | "minor";
  title: string;
  rationale: string;
  required_change: string;
};

export type ReviewFinding = {
  severity: "P0" | "P1" | "P2" | "P3";
  file: string;
  line: number | null;
  title: string;
  rationale: string;
  suggested_fix: string;
};

export type ReviewFindingWithId = ReviewFinding & {
  finding_id: string;
};

type PlanData = {
  plan_markdown: string;
  assumptions: string[];
  risks: string[];
};

type PlanVerifyData = {
  result: "ok" | "ng";
  findings: PlanVerifyFinding[];
};

type PlanFixData = {
  plan_markdown: string;
  addressed_findings: string[];
};

type ReviewData = {
  findings: ReviewFinding[];
};

type SuperviseData = {
  accept_ids: string[];
  reject_ids: string[];
  reject_reasons: Record<string, string>;
  fix_prompt?: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const CLAUDE_PHASES = new Set<RuntimePhase>(["plan", "plan_fix", "review", "supervise"]);
const CODEX_PHASES = new Set<RuntimePhase>(["plan_verify"]);

export async function runPlanningWorkflow(
  inputTask: TaskEntry,
  options: WorkflowOptions,
): Promise<PlanningWorkflowResult> {
  const config = options.config ?? DEFAULT_CONFIG;
  let task = cloneTask(inputTask);
  let planMarkdown: string | undefined;
  let verifierFindings: PlanVerifyFinding[] = [];

  if (task.state === "queued") {
    task = transitionTask(
      task,
      { type: "run_started", resolvedModels: options.resolvedModels },
      config,
    );
  }

  for (let guard = 0; guard < config.plan.max_rounds + 3; guard += 1) {
    if (task.state !== "planning" || task.runtime_phase === null) {
      return { task, planMarkdown, verifierFindings };
    }
    const phase = task.runtime_phase;
    if (phase !== "plan" && phase !== "plan_verify" && phase !== "plan_fix") {
      return {
        task: failWorkflow(task, phase, "other", `unexpected planning phase: ${phase}`, options)
          .task,
        planMarkdown,
        verifierFindings,
      };
    }

    const runnerResult = await runPhase(task, phase, options);
    if (!runnerResult.ok) {
      return { task: runnerResult.task, planMarkdown, verifierFindings };
    }
    const { output } = runnerResult;
    task = runnerResult.task;
    const handled = handleNonCompletedOutput(task, phase, output, options);
    if (handled !== null) {
      return { task: handled, planMarkdown, verifierFindings };
    }

    if (phase === "plan") {
      const data = requireStructuredData<PlanData>(output, phase);
      if (!data.ok) {
        return { task: failPromptContract(task, phase, data.message, options), verifierFindings };
      }
      planMarkdown = data.value.plan_markdown;
      task.plan.state = "verifying";
      task = transitionTask(task, { type: "plan_completed" }, config);
      continue;
    }

    if (phase === "plan_verify") {
      const data = requireStructuredData<PlanVerifyData>(output, phase);
      if (!data.ok) {
        return {
          task: failPromptContract(task, phase, data.message, options),
          planMarkdown,
          verifierFindings,
        };
      }
      verifierFindings = data.value.findings;
      if (data.value.result === "ok") {
        task = transitionTask(task, { type: "plan_verify_accepted" }, config);
        return { task, planMarkdown, verifierFindings };
      }
      task = transitionTask(task, { type: "plan_verify_rejected" }, config);
      if (task.state === "failed") {
        return { task, planMarkdown, verifierFindings };
      }
      continue;
    }

    const data = requireStructuredData<PlanFixData>(output, phase);
    if (!data.ok) {
      return {
        task: failPromptContract(task, phase, data.message, options),
        planMarkdown,
        verifierFindings,
      };
    }
    planMarkdown = data.value.plan_markdown;
    task = transitionTask(task, { type: "plan_fix_completed" }, config);
  }

  return {
    task: failWorkflow(
      task,
      task.runtime_phase ?? "plan",
      "plan_max",
      "planning loop guard exceeded",
      options,
    ).task,
    planMarkdown,
    verifierFindings,
  };
}

export async function runReviewSuperviseWorkflow(
  inputTask: TaskEntry,
  options: WorkflowOptions,
): Promise<ReviewWorkflowResult> {
  const config = options.config ?? DEFAULT_CONFIG;
  let task = cloneTask(inputTask);
  let findings: ReviewFindingWithId[] = [];

  if (task.state !== "reviewing" || task.runtime_phase !== "review") {
    return {
      task: failWorkflow(
        task,
        task.runtime_phase ?? "review",
        "other",
        "review workflow requires state=reviewing and runtime_phase=review",
        options,
      ).task,
      findings,
      acceptedIds: [],
      rejectedIds: [],
    };
  }

  const reviewRunnerResult = await runPhase(task, "review", options);
  if (!reviewRunnerResult.ok) {
    return { task: reviewRunnerResult.task, findings, acceptedIds: [], rejectedIds: [] };
  }
  const reviewOutput = reviewRunnerResult.output;
  task = reviewRunnerResult.task;
  const handledReview = handleNonCompletedOutput(task, "review", reviewOutput, options);
  if (handledReview !== null) {
    return { task: handledReview, findings, acceptedIds: [], rejectedIds: [] };
  }

  const reviewData = requireStructuredData<ReviewData>(reviewOutput, "review");
  if (!reviewData.ok) {
    return {
      task: failPromptContract(task, "review", reviewData.message, options),
      findings,
      acceptedIds: [],
      rejectedIds: [],
    };
  }
  findings = assignFindingIds(reviewData.value.findings);
  task = transitionTask(task, { type: "review_completed" }, config);

  if (findings.length === 0 || everyFindingAlreadyRejected(task, findings)) {
    task = transitionTask(task, { type: "supervise_no_findings" }, config);
    return { task, findings, acceptedIds: [], rejectedIds: [] };
  }

  const superviseRunnerResult = await runPhase(task, "supervise", options, findings);
  if (!superviseRunnerResult.ok) {
    return { task: superviseRunnerResult.task, findings, acceptedIds: [], rejectedIds: [] };
  }
  const superviseOutput = superviseRunnerResult.output;
  task = superviseRunnerResult.task;
  const handledSupervise = handleNonCompletedOutput(task, "supervise", superviseOutput, options);
  if (handledSupervise !== null) {
    return { task: handledSupervise, findings, acceptedIds: [], rejectedIds: [] };
  }

  const superviseData = requireStructuredData<SuperviseData>(superviseOutput, "supervise");
  if (!superviseData.ok) {
    return {
      task: failPromptContract(task, "supervise", superviseData.message, options),
      findings,
      acceptedIds: [],
      rejectedIds: [],
    };
  }

  const validationErrors = validateSupervisorDecision(superviseData.value, findings, task);
  if (validationErrors.length > 0) {
    return {
      task: failPromptContract(task, "supervise", validationErrors.join("; "), options),
      findings,
      acceptedIds: [],
      rejectedIds: [],
    };
  }

  const decisionRound = task.review_round + 1;
  task.review_findings.push({
    round: decisionRound,
    accept_ids: [...superviseData.value.accept_ids],
    reject_ids: [...superviseData.value.reject_ids],
    reject_reasons: { ...superviseData.value.reject_reasons },
  });

  if (superviseData.value.accept_ids.length > 0) {
    task = transitionTask(task, { type: "supervise_accept", origin: "review" }, config);
    return {
      task,
      findings,
      acceptedIds: superviseData.value.accept_ids,
      rejectedIds: superviseData.value.reject_ids,
      fixPrompt: superviseData.value.fix_prompt,
    };
  }

  upsertRejectHistory(task, findings, superviseData.value, decisionRound);
  task = transitionTask(task, { type: "supervise_reject_all" }, config);
  return {
    task,
    findings,
    acceptedIds: [],
    rejectedIds: superviseData.value.reject_ids,
  };
}

export function assignFindingIds(findings: ReviewFinding[]): ReviewFindingWithId[] {
  return findings.map((finding) => ({
    ...finding,
    file: normalizeFindingFile(finding.file),
    title: normalizeFindingTitle(finding.title),
    finding_id: computeFindingId(finding),
  }));
}

export function computeFindingId(finding: ReviewFinding): string {
  const normalizedFile = normalizeFindingFile(finding.file);
  const normalizedTitle = normalizeFindingTitle(finding.title);
  const line = finding.line === null ? "null" : String(finding.line);
  return createHash("sha256")
    .update(`${finding.severity}:${normalizedFile}:${line}:${normalizedTitle}`)
    .digest("hex")
    .slice(0, 16);
}

function buildAgentRunInput(
  task: TaskEntry,
  phase: RuntimePhase,
  options: WorkflowOptions,
  currentFindings?: ReviewFindingWithId[],
): AgentRunInput {
  if (!CLAUDE_PHASES.has(phase) && !CODEX_PHASES.has(phase)) {
    throw new Error(`unsupported workflow runner phase: ${phase}`);
  }
  const provider = phase === "plan_verify" ? "codex" : "claude";
  const workspaceScope = phase === "review" || phase === "supervise" ? "worktree" : "repo";
  return {
    provider,
    phase,
    cwd:
      workspaceScope === "worktree" ? (options.worktreeRoot ?? options.repoRoot) : options.repoRoot,
    prompt: options.buildPrompt?.({ task, phase, currentFindings }) ?? defaultPrompt(task, phase),
    promptContract: promptContractForPhase(phase),
    model: task.runtime.resolved_model[phase] ?? "auto",
    resume: resumeForPhase(task, phase),
    permissions: {
      mode: "readonly",
      allowNetwork: false,
      workspaceScope,
      workspaceRoot:
        workspaceScope === "worktree"
          ? (options.worktreeRoot ?? options.repoRoot)
          : options.repoRoot,
    },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function defaultPrompt(task: TaskEntry, phase: RuntimePhase): string {
  return [
    `Issue #${task.issue}: ${task.title}`,
    `runtime_phase: ${phase}`,
    "Follow the configured prompt_contract and return structured output only.",
  ].join("\n");
}

function resumeForPhase(task: TaskEntry, phase: RuntimePhase): AgentRunInput["resume"] | undefined {
  switch (phase) {
    case "plan":
      return task.provider_sessions.plan.claude_session_id
        ? { claudeSessionId: task.provider_sessions.plan.claude_session_id }
        : undefined;
    case "plan_verify":
      return task.provider_sessions.plan_verify.codex_session_id
        ? { codexSessionId: task.provider_sessions.plan_verify.codex_session_id }
        : undefined;
    case "plan_fix":
      return task.provider_sessions.plan_fix.claude_session_id
        ? { claudeSessionId: task.provider_sessions.plan_fix.claude_session_id }
        : undefined;
    case "review":
      return task.provider_sessions.review.claude_session_id
        ? { claudeSessionId: task.provider_sessions.review.claude_session_id }
        : undefined;
    case "supervise":
      return task.provider_sessions.supervise.claude_session_id
        ? { claudeSessionId: task.provider_sessions.supervise.claude_session_id }
        : undefined;
    default:
      return undefined;
  }
}

function applyRunnerMetadata(
  task: TaskEntry,
  phase: RuntimePhase,
  output: AgentRunOutput,
): TaskEntry {
  const next = cloneTask(task);
  if (output.resolvedModel !== undefined && phase in next.runtime.resolved_model) {
    next.runtime.resolved_model[phase] = output.resolvedModel;
  }
  if (output.session?.claudeSessionId !== undefined) {
    if (phase === "plan")
      next.provider_sessions.plan.claude_session_id = output.session.claudeSessionId;
    if (phase === "plan_fix")
      next.provider_sessions.plan_fix.claude_session_id = output.session.claudeSessionId;
    if (phase === "review")
      next.provider_sessions.review.claude_session_id = output.session.claudeSessionId;
    if (phase === "supervise")
      next.provider_sessions.supervise.claude_session_id = output.session.claudeSessionId;
  }
  if (output.session?.codexSessionId !== undefined && phase === "plan_verify") {
    next.provider_sessions.plan_verify.codex_session_id = output.session.codexSessionId;
  }
  return next;
}

async function runPhase(
  task: TaskEntry,
  phase: RuntimePhase,
  options: WorkflowOptions,
  currentFindings?: ReviewFindingWithId[],
): Promise<{ ok: true; task: TaskEntry; output: AgentRunOutput } | { ok: false; task: TaskEntry }> {
  try {
    const output = await options.runner(buildAgentRunInput(task, phase, options, currentFindings));
    return { ok: true, task: applyRunnerMetadata(task, phase, output), output };
  } catch (error) {
    return { ok: false, task: applyRunnerError(task, phase, error, options) };
  }
}

function handleNonCompletedOutput(
  task: TaskEntry,
  phase: RuntimePhase,
  output: AgentRunOutput,
  options: WorkflowOptions,
): TaskEntry | null {
  if (output.status === "completed") {
    return null;
  }
  if (output.status === "rate_limited") {
    return pauseWorkflow(task, phase, "rate_limited", `rate limit: ${output.summary}`, options);
  }
  if (output.status === "need_input") {
    return pauseWorkflow(
      task,
      phase,
      "need_input_pending",
      output.question?.text ?? output.summary,
      options,
    );
  }
  if (output.status === "paused") {
    return pauseWorkflow(task, phase, "other", output.summary, options);
  }
  return failWorkflow(task, phase, "other", output.summary, options).task;
}

function applyRunnerError(
  task: TaskEntry,
  phase: RuntimePhase,
  error: unknown,
  options: WorkflowOptions,
): TaskEntry {
  const code = failureCodeFromError(error) ?? "other";
  const message = error instanceof Error ? error.message : "runner failed";
  if (PAUSED_FAILURE_CODES.has(code)) {
    return pauseWorkflow(task, phase, code, message, options);
  }
  return failWorkflow(task, phase, code, message, options).task;
}

function requireStructuredData<T>(
  output: AgentRunOutput,
  phase: RuntimePhase,
): { ok: true; value: T } | { ok: false; message: string } {
  if (!isRecord(output.structured)) {
    return { ok: false, message: `${phase} completed without structured data` };
  }
  return { ok: true, value: output.structured as T };
}

function failPromptContract(
  task: TaskEntry,
  phase: RuntimePhase,
  message: string,
  options: WorkflowOptions,
): TaskEntry {
  return failWorkflow(task, phase, "prompt_contract_violation", message, options).task;
}

function failWorkflow(
  task: TaskEntry,
  phase: RuntimePhase | string,
  code: FailureCode,
  message: string,
  options: WorkflowOptions,
): WorkflowResult {
  return {
    task: transitionTask(task, {
      type: "fail",
      failure: makeFailure({ phase, code, message, ts: options.now?.() }),
    }),
  };
}

function pauseWorkflow(
  task: TaskEntry,
  phase: RuntimePhase,
  code: FailureCode,
  message: string,
  options: WorkflowOptions,
): TaskEntry {
  return transitionTask(task, {
    type: "pause",
    failure: makeFailure({ phase, code, message, ts: options.now?.() }),
  });
}

function validateSupervisorDecision(
  data: SuperviseData,
  findings: ReviewFindingWithId[],
  task: TaskEntry,
): string[] {
  const errors: string[] = [];
  const currentIds = new Set(findings.map((finding) => finding.finding_id));
  const accepted = new Set<string>();
  const rejected = new Set<string>();
  const knownRejected = rejectedFindingIds(task);

  for (const id of data.accept_ids) {
    if (accepted.has(id)) errors.push(`duplicate accept_id: ${id}`);
    accepted.add(id);
    if (!currentIds.has(id)) errors.push(`accept_id is not in current findings: ${id}`);
    if (knownRejected.has(id)) errors.push(`known rejected finding_id cannot be accepted: ${id}`);
  }
  for (const id of data.reject_ids) {
    if (rejected.has(id)) errors.push(`duplicate reject_id: ${id}`);
    rejected.add(id);
    if (!currentIds.has(id)) errors.push(`reject_id is not in current findings: ${id}`);
    if (!(id in data.reject_reasons)) errors.push(`reject_reasons is missing reject_id: ${id}`);
  }
  for (const id of accepted) {
    if (rejected.has(id)) errors.push(`finding_id cannot be both accepted and rejected: ${id}`);
  }

  for (const id of currentIds) {
    if (!accepted.has(id) && !rejected.has(id) && !knownRejected.has(id)) {
      errors.push(`finding_id is not classified: ${id}`);
    }
  }
  if (data.accept_ids.length > 0 && data.fix_prompt === undefined) {
    errors.push("fix_prompt is required when accept_ids is non-empty");
  }
  return errors;
}

function upsertRejectHistory(
  task: TaskEntry,
  findings: ReviewFindingWithId[],
  data: SuperviseData,
  rejectedAtRound: number,
): void {
  const byId = new Map(findings.map((finding) => [finding.finding_id, finding]));
  for (const id of data.reject_ids) {
    const existing = task.reject_history.find((entry) => findingIdFromRejectHistory(entry) === id);
    if (existing !== undefined) {
      existing.rejected_at_round = rejectedAtRound;
      existing.reason = data.reject_reasons[id];
      continue;
    }
    const finding = byId.get(id);
    if (finding === undefined) {
      continue;
    }
    task.reject_history.push({
      finding_id: id,
      rejected_at_round: rejectedAtRound,
      reason: data.reject_reasons[id],
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      title: finding.title,
      rationale: finding.rationale,
      suggested_fix: finding.suggested_fix,
    });
  }
}

function everyFindingAlreadyRejected(task: TaskEntry, findings: ReviewFindingWithId[]): boolean {
  if (findings.length === 0) {
    return true;
  }
  const rejected = rejectedFindingIds(task);
  return findings.every((finding) => rejected.has(finding.finding_id));
}

function rejectedFindingIds(task: TaskEntry): Set<string> {
  return new Set(
    task.reject_history
      .map((entry) => findingIdFromRejectHistory(entry))
      .filter((value): value is string => typeof value === "string"),
  );
}

function findingIdFromRejectHistory(entry: Record<string, unknown>): string | undefined {
  return typeof entry.finding_id === "string" ? entry.finding_id : undefined;
}

function normalizeFindingFile(file: string): string {
  const normalized = posix.normalize(file.trim().replaceAll("\\", "/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function normalizeFindingTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function isRecord(value: unknown): value is PromptContractData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failureCodeFromError(error: unknown): FailureCode | undefined {
  if (!isRecord(error) || typeof error.code !== "string") {
    return undefined;
  }
  return isFailureCode(error.code) ? error.code : undefined;
}

function isFailureCode(code: string): code is FailureCode {
  return (failureCodes as readonly string[]).includes(code);
}

const PAUSED_FAILURE_CODES = new Set<FailureCode>([
  "rate_limited",
  "branch_protection",
  "need_input_pending",
  "interrupted",
  "branch_delete_failed",
  "worktree_remove_failed",
  "merge_sha_mismatch",
  "ci_timeout",
  "merge_timeout",
  "rebase_conflict",
  "retry_cleanup_failed",
  "sanitize_violation",
  "sandbox_violation",
  "auto_mode_unavailable",
  "network_required",
  "manual_merge_required",
  "pre_pr_active_orphan",
]);
