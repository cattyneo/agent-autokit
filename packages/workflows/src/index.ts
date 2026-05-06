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
  planMarkdown?: string;
  currentFindings?: ReviewFindingWithId[];
};

export type WorkflowQuestionInput = {
  task: TaskEntry;
  phase: RuntimePhase;
  question: NonNullable<AgentRunOutput["question"]>;
  turn: number;
};

export type WorkflowOptions = {
  runner: WorkflowRunner;
  repoRoot: string;
  worktreeRoot?: string;
  timeoutMs?: number;
  timeoutMsForPhase?: (phase: RuntimePhase) => number;
  config?: AutokitConfig;
  resolvedModels?: Record<string, string>;
  buildPrompt?: (input: WorkflowPromptInput) => string;
  answerQuestion?: (input: WorkflowQuestionInput) => Promise<string> | string;
  persistTask?: (task: TaskEntry) => Promise<void> | void;
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

export type BranchPrLookup =
  | {
      state: "OPEN" | "MERGED" | "CLOSED";
      number: number;
      headSha: string | null;
      baseSha?: string | null;
    }
  | { state: "NONE" };

export type ImplementFixGitDeps = {
  getHeadSha: () => Promise<string> | string;
  stageAll: () => Promise<void> | void;
  commit: (input: { message: string }) => Promise<string> | string;
  pushBranch: (branch: string) => Promise<void> | void;
  findPrForBranch?: (branch: string) => Promise<BranchPrLookup> | BranchPrLookup;
  createDraftPr: (input: { task: TaskEntry; headSha: string }) => Promise<number> | number;
  getPrHead: (
    prNumber: number,
  ) =>
    | Promise<{ headSha: string; baseSha?: string | null }>
    | { headSha: string; baseSha?: string | null };
  markPrReady: (prNumber: number) => Promise<void> | void;
  rebaseOntoBase: () =>
    | Promise<{ ok: true } | { ok: false; message: string }>
    | { ok: true }
    | { ok: false; message: string };
};

export type ImplementFixWorkflowOptions = WorkflowOptions & {
  git: ImplementFixGitDeps;
  commitMessage?: (input: { task: TaskEntry; phase: "implement" | "fix" }) => string;
};

export type ImplementFixWorkflowResult = WorkflowResult & {
  changedFiles: string[];
  testsRun: TestEvidence[];
};

export type CiCheckObservation =
  | { status: "success" }
  | { status: "failure"; failedLog: string }
  | { status: "pending" };

export type CiWaitPrObservation = {
  headSha: string | null;
  mergeable: "MERGEABLE" | "BLOCKED" | "UNKNOWN";
  autoMergeRequest?: unknown | null;
};

export type CiWaitDeps = {
  getChecks: (prNumber: number) => Promise<CiCheckObservation> | CiCheckObservation;
  getPr: (
    prNumber: number,
    site: "pre_reservation_check" | "post_reservation_recheck" | "auto_merge_disabled_barrier",
  ) => Promise<CiWaitPrObservation> | CiWaitPrObservation;
  reserveAutoMerge: (input: { prNumber: number; headSha: string }) => Promise<void> | void;
  disableAutoMerge: (prNumber: number) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void> | void;
};

export type CiWaitWorkflowOptions = WorkflowOptions & {
  github: CiWaitDeps;
  startedAtMs?: number;
  nowMs?: () => number;
};

export type CiWaitWorkflowResult = WorkflowResult & {
  ciFailureLog?: string;
};

export type MergePrObservation = {
  state: "OPEN" | "MERGED" | "CLOSED";
  merged: boolean;
  headSha: string | null;
  mergeable: "MERGEABLE" | "BLOCKED" | "UNKNOWN";
};

export type AutoMergeStatusObservation = {
  autoMergeRequest?: unknown | null;
};

export type MergeDeps = {
  getPr: (prNumber: number) => Promise<MergePrObservation> | MergePrObservation;
  getAutoMergeStatus: (
    prNumber: number,
  ) => Promise<AutoMergeStatusObservation> | AutoMergeStatusObservation;
  disableAutoMerge: (prNumber: number) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void> | void;
};

export type MergeWorkflowOptions = WorkflowOptions & {
  github: MergeDeps;
  startedAtMs?: number;
  nowMs?: () => number;
};

export type CleaningStepResult = { ok: true } | { ok: false; message: string };

export type CleaningDeps = {
  deleteRemoteBranch: (branch: string) => Promise<CleaningStepResult> | CleaningStepResult;
  removeWorktree: (
    worktreePath: string,
    options: { force: boolean },
  ) => Promise<CleaningStepResult> | CleaningStepResult;
  pruneWorktrees?: () => Promise<CleaningStepResult> | CleaningStepResult;
  sleep?: (ms: number) => Promise<void> | void;
};

export type CleaningWorkflowOptions = WorkflowOptions & {
  cleanup: CleaningDeps;
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

type TestEvidence = {
  command: string;
  result: "passed" | "failed" | "skipped";
  summary: string;
};

type ImplementData = {
  changed_files: string[];
  tests_run: TestEvidence[];
  docs_updated: boolean;
  notes: string;
};

type FixData = {
  changed_files: string[];
  tests_run: TestEvidence[];
  resolved_accept_ids: string[];
  unresolved_accept_ids: string[];
  notes: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const CLAUDE_PHASES = new Set<RuntimePhase>(["plan", "plan_fix", "review", "supervise"]);
const CODEX_PHASES = new Set<RuntimePhase>(["plan_verify", "implement", "fix"]);

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

    const runnerResult = await runPhase(task, phase, options, undefined, planMarkdown);
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
  upsertRejectHistory(task, findings, superviseData.value, decisionRound);

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

  task = transitionTask(task, { type: "supervise_reject_all" }, config);
  return {
    task,
    findings,
    acceptedIds: [],
    rejectedIds: superviseData.value.reject_ids,
  };
}

export async function runImplementWorkflow(
  inputTask: TaskEntry,
  options: ImplementFixWorkflowOptions,
): Promise<ImplementFixWorkflowResult> {
  let task = cloneTask(inputTask);

  if (task.state === "planned" && task.runtime_phase === null && task.plan.state === "verified") {
    const beforeSha = await options.git.getHeadSha();
    task.git.base_sha ??= beforeSha;
    task = transitionTask(task, { type: "implement_started", beforeSha: beforeSha });
    await persistTask(task, options);
  }

  if (task.state !== "implementing" || task.runtime_phase !== "implement") {
    return {
      task: failWorkflow(
        task,
        task.runtime_phase ?? "implement",
        "other",
        "implement workflow requires state=implementing and runtime_phase=implement",
        options,
      ).task,
      changedFiles: [],
      testsRun: [],
    };
  }

  if (task.git.checkpoints.implement.before_sha === null) {
    task.git.checkpoints.implement.before_sha = await options.git.getHeadSha();
    task.git.base_sha ??= task.git.checkpoints.implement.before_sha;
    await persistTask(task, options);
  }

  let changedFiles: string[] = [];
  let testsRun: TestEvidence[] = [];

  if (task.git.checkpoints.implement.agent_done === null) {
    const runnerResult = await runPhase(task, "implement", options);
    if (!runnerResult.ok) {
      return { task: runnerResult.task, changedFiles: [], testsRun: [] };
    }
    task = runnerResult.task;
    const handled = handleNonCompletedOutput(task, "implement", runnerResult.output, options);
    if (handled !== null) {
      return { task: handled, changedFiles: [], testsRun: [] };
    }
    const data = requireStructuredData<ImplementData>(runnerResult.output, "implement");
    if (!data.ok) {
      return {
        task: failPromptContract(task, "implement", data.message, options),
        changedFiles: [],
        testsRun: [],
      };
    }
    changedFiles = data.value.changed_files;
    testsRun = data.value.tests_run;
    task.git.checkpoints.implement.agent_done = await options.git.getHeadSha();
    await persistTask(task, options);
  }

  if (task.git.checkpoints.implement.commit_done === null) {
    await options.git.stageAll();
    task.git.checkpoints.implement.commit_done = await options.git.commit({
      message:
        options.commitMessage?.({ task, phase: "implement" }) ??
        defaultCommitMessage(task, "implement"),
    });
    await persistTask(task, options);
  }
  const commitSha = task.git.checkpoints.implement.commit_done;

  if (task.git.checkpoints.implement.push_done === null) {
    await options.git.pushBranch(requireBranch(task));
    task.git.checkpoints.implement.push_done = commitSha;
    await persistTask(task, options);
  }

  if (task.git.checkpoints.implement.pr_created === null) {
    const restored = await restoreOrCreatePrAfterPush(task, commitSha, options);
    if (!restored.ok) {
      return { task: restored.task, changedFiles, testsRun };
    }
    task = restored.task;
  }

  if (task.git.checkpoints.implement.head_sha_persisted === null) {
    const prNumber = requirePrNumber(task);
    const prHead = await options.git.getPrHead(prNumber);
    task.pr.head_sha = prHead.headSha;
    task.pr.base_sha = prHead.baseSha ?? task.pr.base_sha;
    task.git.checkpoints.implement.head_sha_persisted = prHead.headSha;
    await persistTask(task, options);
  }

  if (task.git.checkpoints.implement.after_sha === null) {
    const prNumber = requirePrNumber(task);
    const headSha = requirePrHead(task);
    await options.git.markPrReady(prNumber);
    task = transitionTask(task, {
      type: "pr_ready",
      headSha,
      prNumber,
      baseSha: task.pr.base_sha ?? undefined,
    });
    await persistTask(task, options);
  } else if (task.state === "implementing") {
    task = transitionTask(task, {
      type: "pr_ready",
      headSha: task.git.checkpoints.implement.after_sha,
      prNumber: task.pr.number ?? undefined,
      baseSha: task.pr.base_sha ?? undefined,
    });
    await persistTask(task, options);
  }

  return { task, changedFiles, testsRun };
}

export async function runFixWorkflow(
  inputTask: TaskEntry,
  options: ImplementFixWorkflowOptions,
): Promise<ImplementFixWorkflowResult> {
  let task = cloneTask(inputTask);

  if (task.state !== "fixing" || task.runtime_phase !== "fix") {
    return {
      task: failWorkflow(
        task,
        task.runtime_phase ?? "fix",
        "other",
        "fix workflow requires state=fixing and runtime_phase=fix",
        options,
      ).task,
      changedFiles: [],
      testsRun: [],
    };
  }
  if (task.pr.number === null) {
    return {
      task: failWorkflow(
        task,
        "fix",
        "pre_pr_active_orphan",
        "fix workflow requires an existing PR",
        options,
      ).task,
      changedFiles: [],
      testsRun: [],
    };
  }
  const prNumber = task.pr.number;

  if (task.git.checkpoints.fix.before_sha === null) {
    task.git.checkpoints.fix.before_sha = await options.git.getHeadSha();
    await persistTask(task, options);
  }

  if (task.git.checkpoints.fix.rebase_done === null) {
    const rebase = await options.git.rebaseOntoBase();
    if (!rebase.ok) {
      return {
        task: pauseWorkflow(task, "fix", "rebase_conflict", rebase.message, options),
        changedFiles: [],
        testsRun: [],
      };
    }
    task.git.checkpoints.fix.rebase_done = await options.git.getHeadSha();
    await persistTask(task, options);
  }

  let changedFiles: string[] = [];
  let testsRun: TestEvidence[] = [];

  if (task.git.checkpoints.fix.agent_done === null) {
    const runnerResult = await runPhase(task, "fix", options);
    if (!runnerResult.ok) {
      return { task: runnerResult.task, changedFiles: [], testsRun: [] };
    }
    task = runnerResult.task;
    const handled = handleNonCompletedOutput(task, "fix", runnerResult.output, options);
    if (handled !== null) {
      return { task: handled, changedFiles: [], testsRun: [] };
    }
    const data = requireStructuredData<FixData>(runnerResult.output, "fix");
    if (!data.ok) {
      return {
        task: failPromptContract(task, "fix", data.message, options),
        changedFiles: [],
        testsRun: [],
      };
    }
    changedFiles = data.value.changed_files;
    testsRun = data.value.tests_run;
    task.git.checkpoints.fix.agent_done = await options.git.getHeadSha();
    await persistTask(task, options);
  }

  if (task.git.checkpoints.fix.commit_done === null) {
    await options.git.stageAll();
    task.git.checkpoints.fix.commit_done = await options.git.commit({
      message: options.commitMessage?.({ task, phase: "fix" }) ?? defaultCommitMessage(task, "fix"),
    });
    await persistTask(task, options);
  }
  const commitSha = task.git.checkpoints.fix.commit_done;

  if (task.git.checkpoints.fix.push_done === null) {
    await options.git.pushBranch(requireBranch(task));
    task.git.checkpoints.fix.push_done = commitSha;
    await persistTask(task, options);
  }

  if (task.git.checkpoints.fix.head_sha_persisted === null) {
    const prHead = await options.git.getPrHead(prNumber);
    task.pr.head_sha = prHead.headSha;
    task.pr.base_sha = prHead.baseSha ?? task.pr.base_sha;
    task.git.checkpoints.fix.head_sha_persisted = prHead.headSha;
    await persistTask(task, options);
  }

  if (task.git.checkpoints.fix.after_sha === null) {
    task.git.checkpoints.fix.after_sha = requirePrHead(task);
    task = transitionTask(task, { type: "fix_pushed" });
    task.git.checkpoints.fix.after_sha = requirePrHead(task);
    await persistTask(task, options);
  } else if (task.state === "fixing") {
    task = transitionTask(task, { type: "fix_pushed" });
    task.git.checkpoints.fix.after_sha = requirePrHead(task);
    await persistTask(task, options);
  }

  return { task, changedFiles, testsRun };
}

export async function runCiWaitWorkflow(
  inputTask: TaskEntry,
  options: CiWaitWorkflowOptions,
): Promise<CiWaitWorkflowResult> {
  const config = options.config ?? DEFAULT_CONFIG;
  let task = cloneTask(inputTask);
  if (task.state !== "ci_waiting" || task.runtime_phase !== "ci_wait") {
    return {
      task: failWorkflow(
        task,
        task.runtime_phase ?? "ci_wait",
        "other",
        "ci-wait workflow requires state=ci_waiting and runtime_phase=ci_wait",
        options,
      ).task,
    };
  }
  const prNumber = requirePrNumber(task);
  const expectedHead = requirePrHead(task);
  const startedAt = options.startedAtMs ?? currentMs(options);

  for (;;) {
    if (currentMs(options) - startedAt >= config.ci.timeout_ms) {
      if (config.ci.timeout_action === "failed") {
        await options.github.disableAutoMerge(prNumber);
      }
      return { task: transitionTask(task, { type: "ci_timeout" }, config) };
    }

    const checks = await options.github.getChecks(prNumber);
    if (checks.status === "pending") {
      await sleepFor(config.ci.poll_interval_ms, options);
      continue;
    }
    if (checks.status === "failure") {
      return {
        task: transitionTask(task, { type: "ci_failed" }, config),
        ciFailureLog: checks.failedLog,
      };
    }

    const preReservation = await options.github.getPr(prNumber, "pre_reservation_check");
    if (preReservation.headSha !== expectedHead) {
      return { task: transitionTask(task, { type: "ci_head_mismatch" }, config) };
    }
    if (preReservation.mergeable === "BLOCKED") {
      return { task: transitionTask(task, { type: "ci_branch_protection" }, config) };
    }
    if (preReservation.mergeable === "UNKNOWN") {
      await sleepFor(config.merge.poll_interval_ms, options);
      continue;
    }

    if (!config.auto_merge) {
      return { task: transitionTask(task, { type: "ci_passed_manual_merge" }, config) };
    }

    await options.github.reserveAutoMerge({ prNumber, headSha: expectedHead });
    const postReservation = await options.github.getPr(prNumber, "post_reservation_recheck");
    if (postReservation.headSha !== expectedHead) {
      await options.github.disableAutoMerge(prNumber);
      await waitForAutoMergeDisabled(prNumber, options);
      task = invalidateLatestAcceptedFindings(task);
      return { task: transitionTask(task, { type: "ci_head_mismatch" }, config) };
    }

    return { task: transitionTask(task, { type: "auto_merge_reserved" }, config) };
  }
}

export async function runMergeWorkflow(
  inputTask: TaskEntry,
  options: MergeWorkflowOptions,
): Promise<WorkflowResult> {
  const config = options.config ?? DEFAULT_CONFIG;
  const task = cloneTask(inputTask);
  if (task.state !== "merging" || task.runtime_phase !== "merge") {
    return {
      task: failWorkflow(
        task,
        task.runtime_phase ?? "merge",
        "other",
        "merge workflow requires state=merging and runtime_phase=merge",
        options,
      ).task,
    };
  }
  const prNumber = requirePrNumber(task);
  const expectedHead = requirePrHead(task);
  const startedAt = options.startedAtMs ?? currentMs(options);

  for (;;) {
    if (currentMs(options) - startedAt >= config.merge.timeout_ms) {
      await disableAutoMergeAndWait(prNumber, options);
      return { task: transitionTask(task, { type: "merge_timeout" }, config) };
    }

    const pr = await options.github.getPr(prNumber);
    if (pr.state === "MERGED" || pr.merged) {
      if (pr.headSha !== expectedHead) {
        await disableAutoMergeAndWait(prNumber, options);
      }
      return { task: transitionTask(task, { type: "pr_merged", headSha: pr.headSha }, config) };
    }
    if (pr.state === "CLOSED") {
      await disableAutoMergeAndWait(prNumber, options);
      return { task: transitionTask(task, { type: "pr_closed_unmerged" }, config) };
    }
    if (pr.mergeable === "BLOCKED") {
      await disableAutoMergeAndWait(prNumber, options);
      return { task: transitionTask(task, { type: "merge_blocked" }, config) };
    }
    await sleepFor(config.merge.poll_interval_ms, options);
  }
}

export async function runCleaningWorkflow(
  inputTask: TaskEntry,
  options: CleaningWorkflowOptions,
): Promise<WorkflowResult> {
  const config = options.config ?? DEFAULT_CONFIG;
  let task = cloneTask(inputTask);
  if (task.state !== "cleaning" || task.runtime_phase !== null) {
    return {
      task: failWorkflow(
        task,
        task.runtime_phase ?? "cleaning",
        "other",
        "cleaning workflow requires state=cleaning and runtime_phase=null",
        options,
      ).task,
    };
  }

  if (!task.cleaning_progress.grace_period_done) {
    await sleepFor(config.merge.branch_delete_grace_ms, options);
    task.cleaning_progress.grace_period_done = true;
    await persistTask(task, options);
  }

  if (!task.cleaning_progress.branch_deleted_done) {
    const branch = requireBranch(task);
    const deleted = await options.cleanup.deleteRemoteBranch(branch);
    if (!deleted.ok) {
      return {
        task: transitionTask(task, {
          type: "cleaning_branch_failed",
          message: `branch cleanup incomplete: ${deleted.message}`,
        }),
      };
    }
    task.cleaning_progress.branch_deleted_done = true;
    await persistTask(task, options);
  }

  if (!task.cleaning_progress.worktree_removed_done) {
    const worktreePath = requireWorktreePath(task);
    const removed = await removeWorktreeWithRetry(task, worktreePath, config, options);
    if (!removed.ok) {
      return { task: removed.task };
    }
    task = removed.task;
    task.cleaning_progress.worktree_removed_done = true;
    task.cleaning_progress.worktree_remove_attempts = 0;
    await persistTask(task, options);
  }

  task = transitionTask(task, { type: "cleaning_completed" }, config);
  await persistTask(task, options);
  return { task };
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
  planMarkdown?: string,
  questionResponse?: AgentRunInput["questionResponse"],
): AgentRunInput {
  if (!CLAUDE_PHASES.has(phase) && !CODEX_PHASES.has(phase)) {
    throw new Error(`unsupported workflow runner phase: ${phase}`);
  }
  const provider = phase === "plan_verify" ? "codex" : "claude";
  const providerForPhase = CODEX_PHASES.has(phase) ? "codex" : provider;
  const workspaceScope =
    phase === "review" || phase === "supervise" || phase === "implement" || phase === "fix"
      ? "worktree"
      : "repo";
  const mode = phase === "implement" || phase === "fix" ? "workspace-write" : "readonly";
  return {
    provider: providerForPhase,
    phase,
    cwd:
      workspaceScope === "worktree" ? (options.worktreeRoot ?? options.repoRoot) : options.repoRoot,
    prompt:
      options.buildPrompt?.({ task, phase, planMarkdown, currentFindings }) ??
      defaultPrompt(task, phase),
    promptContract: promptContractForPhase(phase),
    model: task.runtime.resolved_model[phase] ?? "auto",
    resume: resumeForPhase(task, phase),
    questionResponse,
    permissions: {
      mode,
      allowNetwork: false,
      workspaceScope,
      workspaceRoot:
        workspaceScope === "worktree"
          ? (options.worktreeRoot ?? options.repoRoot)
          : options.repoRoot,
    },
    timeoutMs: options.timeoutMsForPhase?.(phase) ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
  const session = task.provider_sessions[phase];
  switch (phase) {
    case "plan":
      return session.claude_session_id ? { claudeSessionId: session.claude_session_id } : undefined;
    case "plan_verify":
      return session.codex_session_id ? { codexSessionId: session.codex_session_id } : undefined;
    case "plan_fix":
      return session.claude_session_id ? { claudeSessionId: session.claude_session_id } : undefined;
    case "review":
      return session.claude_session_id ? { claudeSessionId: session.claude_session_id } : undefined;
    case "supervise":
      return session.claude_session_id ? { claudeSessionId: session.claude_session_id } : undefined;
    case "implement":
      return session.codex_session_id ? { codexSessionId: session.codex_session_id } : undefined;
    case "fix":
      return session.codex_session_id ? { codexSessionId: session.codex_session_id } : undefined;
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
    next.provider_sessions[phase].claude_session_id = output.session.claudeSessionId;
    next.provider_sessions[phase].last_provider = "claude";
  }
  if (output.session?.codexSessionId !== undefined) {
    next.provider_sessions[phase].codex_session_id = output.session.codexSessionId;
    next.provider_sessions[phase].last_provider = "codex";
  }
  return next;
}

async function runPhase(
  task: TaskEntry,
  phase: RuntimePhase,
  options: WorkflowOptions,
  currentFindings?: ReviewFindingWithId[],
  planMarkdown?: string,
): Promise<{ ok: true; task: TaskEntry; output: AgentRunOutput } | { ok: false; task: TaskEntry }> {
  let currentTask = task;
  let questionResponse: AgentRunInput["questionResponse"];
  for (let turn = 0; turn < 3; turn += 1) {
    try {
      const output = await options.runner(
        buildAgentRunInput(
          currentTask,
          phase,
          options,
          currentFindings,
          planMarkdown,
          questionResponse,
        ),
      );
      currentTask = applyRunnerMetadata(currentTask, phase, output);
      if (output.status !== "need_input" || options.answerQuestion === undefined) {
        return { ok: true, task: currentTask, output };
      }
      if (output.question === undefined) {
        return { ok: true, task: currentTask, output };
      }
      const answer = await options.answerQuestion({
        task: currentTask,
        phase,
        question: output.question,
        turn,
      });
      questionResponse = { ...output.question, answer };
    } catch (error) {
      return { ok: false, task: applyRunnerError(currentTask, phase, error, options) };
    }
  }
  return {
    ok: false,
    task: pauseWorkflow(
      currentTask,
      phase,
      "need_input_pending",
      "need_input answer turn limit exceeded",
      options,
    ),
  };
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
      formatNeedInputMessage(output),
      options,
    );
  }
  if (output.status === "paused") {
    return pauseWorkflow(task, phase, "other", output.summary, options);
  }
  return failWorkflow(task, phase, "other", output.summary, options).task;
}

function formatNeedInputMessage(output: AgentRunOutput): string {
  if (output.question === undefined) {
    return output.summary;
  }
  return `${output.question.text} (default: ${output.question.default})`;
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

async function persistTask(task: TaskEntry, options: WorkflowOptions): Promise<void> {
  await options.persistTask?.(cloneTask(task));
}

function currentMs(options: { nowMs?: () => number }): number {
  return options.nowMs?.() ?? Date.now();
}

async function sleepFor(
  ms: number,
  options: CiWaitWorkflowOptions | MergeWorkflowOptions | CleaningWorkflowOptions,
): Promise<void> {
  const sleeper = "github" in options ? options.github.sleep : options.cleanup.sleep;
  if (sleeper !== undefined) {
    await sleeper(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeWorktreeWithRetry(
  task: TaskEntry,
  worktreePath: string,
  config: AutokitConfig,
  options: CleaningWorkflowOptions,
): Promise<{ ok: true; task: TaskEntry } | { ok: false; task: TaskEntry }> {
  const next = cloneTask(task);
  for (;;) {
    const removed = await options.cleanup.removeWorktree(worktreePath, { force: false });
    if (removed.ok) {
      return { ok: true, task: next };
    }
    next.cleaning_progress.worktree_remove_attempts += 1;
    await persistTask(next, options);

    if (next.cleaning_progress.worktree_remove_attempts >= config.merge.worktree_remove_retry_max) {
      const forced = await options.cleanup.removeWorktree(worktreePath, { force: true });
      if (forced.ok) {
        return { ok: true, task: next };
      }
      const pruned = await options.cleanup.pruneWorktrees?.();
      if (pruned?.ok) {
        return { ok: true, task: next };
      }
      const message = pruned && !pruned.ok ? pruned.message : forced.message;
      return {
        ok: false,
        task: transitionTask(next, {
          type: "cleaning_worktree_failed",
          message: `worktree cleanup incomplete after ${next.cleaning_progress.worktree_remove_attempts} attempts: ${message}`,
        }),
      };
    }

    await sleepFor(worktreeBackoffMs(next.cleaning_progress.worktree_remove_attempts), options);
  }
}

function worktreeBackoffMs(attempts: number): number {
  return Math.min(9_000, attempts === 1 ? 1_000 : attempts === 2 ? 3_000 : 9_000);
}

async function waitForAutoMergeDisabled(
  prNumber: number,
  options: CiWaitWorkflowOptions,
): Promise<void> {
  let consecutiveNull = 0;
  while (consecutiveNull < 2) {
    await sleepFor((options.config ?? DEFAULT_CONFIG).merge.poll_interval_ms, options);
    const observed = await options.github.getPr(prNumber, "auto_merge_disabled_barrier");
    consecutiveNull = observed.autoMergeRequest == null ? consecutiveNull + 1 : 0;
  }
}

async function disableAutoMergeAndWait(
  prNumber: number,
  options: MergeWorkflowOptions,
): Promise<void> {
  await options.github.disableAutoMerge(prNumber);
  let consecutiveNull = 0;
  while (consecutiveNull < 2) {
    await sleepFor((options.config ?? DEFAULT_CONFIG).merge.poll_interval_ms, options);
    const observed = await options.github.getAutoMergeStatus(prNumber);
    consecutiveNull = observed.autoMergeRequest == null ? consecutiveNull + 1 : 0;
  }
}

function invalidateLatestAcceptedFindings(task: TaskEntry): TaskEntry {
  const next = cloneTask(task);
  const latest = next.review_findings.at(-1);
  if (latest !== undefined) {
    latest.accept_ids = [];
  }
  return next;
}

async function restoreOrCreatePrAfterPush(
  task: TaskEntry,
  headSha: string,
  options: ImplementFixWorkflowOptions,
): Promise<{ ok: true; task: TaskEntry } | { ok: false; task: TaskEntry }> {
  const branch = requireBranch(task);
  const existing = await options.git.findPrForBranch?.(branch);
  if (existing !== undefined && existing.state !== "NONE") {
    if (existing.state !== "OPEN") {
      return {
        ok: false,
        task: pauseWorkflow(
          task,
          "implement",
          "pre_pr_active_orphan",
          `branch PR is ${existing.state.toLowerCase()}`,
          options,
        ),
      };
    }
    const next = cloneTask(task);
    next.pr.number = existing.number;
    next.pr.head_sha = existing.headSha;
    next.pr.base_sha = existing.baseSha ?? next.pr.base_sha;
    next.git.checkpoints.implement.pr_created = existing.number;
    await persistTask(next, options);
    return { ok: true, task: next };
  }

  const next = cloneTask(task);
  const prNumber = await options.git.createDraftPr({ task: next, headSha });
  next.pr.number = prNumber;
  next.pr.created_at = options.now?.() ?? new Date().toISOString();
  next.git.checkpoints.implement.pr_created = prNumber;
  await persistTask(next, options);
  return { ok: true, task: next };
}

function defaultCommitMessage(task: TaskEntry, phase: "implement" | "fix"): string {
  const prefix = phase === "implement" ? "Implement" : "Fix";
  return `${prefix} issue #${task.issue}`;
}

function requireBranch(task: TaskEntry): string {
  if (task.branch === null) {
    throw new Error("task branch is required");
  }
  return task.branch;
}

function requireWorktreePath(task: TaskEntry): string {
  if (task.worktree_path === null) {
    throw new Error("task worktree path is required");
  }
  return task.worktree_path;
}

function requirePrNumber(task: TaskEntry): number {
  if (task.pr.number === null) {
    throw new Error("task PR number is required");
  }
  return task.pr.number;
}

function requirePrHead(task: TaskEntry): string {
  if (task.pr.head_sha === null) {
    throw new Error("task PR head SHA is required");
  }
  return task.pr.head_sha;
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
