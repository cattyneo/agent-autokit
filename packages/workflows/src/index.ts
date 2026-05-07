import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  type AgentRunInput,
  type AgentRunOutput,
  type AutokitConfig,
  cloneTask,
  DEFAULT_CONFIG,
  derive_claude_perm,
  derive_codex_perm,
  type EffectivePermission,
  type EffortLevel,
  type FailureCode,
  failureCodes,
  makeFailure,
  type OperationalAuditKind,
  type PermissionProfile,
  type Phase,
  type PromptContractData,
  type Provider,
  promptContractForPhase,
  type RuntimePhase,
  resolveEffort,
  resolveRunnerTimeout,
  sanitizeLogString,
  type TaskEntry,
  transitionTask,
  validateCapabilitySelection,
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
  getHeadSha?: (phase: RuntimePhase) => Promise<string> | string;
  persistTask?: (task: TaskEntry) => Promise<void> | void;
  auditOperation?: (kind: OperationalAuditKind, fields: Record<string, unknown>) => void;
  now?: () => string;
  homeDir?: string;
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

type CompletedPhaseResult<T> =
  | { ok: true; task: TaskEntry; output: AgentRunOutput; data: T }
  | { ok: false; task: TaskEntry };

export async function runPlanningWorkflow(
  inputTask: TaskEntry,
  options: WorkflowOptions,
): Promise<PlanningWorkflowResult> {
  const config = options.config ?? DEFAULT_CONFIG;
  let task = cloneTask(inputTask);
  let planMarkdown: string | undefined;
  let verifierFindings: PlanVerifyFinding[] = [];
  let phaseStartedInThisInvocation = false;

  if (task.state === "queued") {
    task = transitionTask(
      task,
      { type: "run_started", resolvedModels: options.resolvedModels },
      config,
    );
    phaseStartedInThisInvocation = true;
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

    if (phase === "plan") {
      const completed = await runCompletedPhase<PlanData>(
        task,
        phase,
        options,
        undefined,
        planMarkdown,
        undefined,
        { countColdRestart: !phaseStartedInThisInvocation },
      );
      phaseStartedInThisInvocation = false;
      if (!completed.ok) {
        return { task: completed.task, planMarkdown, verifierFindings };
      }
      task = completed.task;
      planMarkdown = completed.data.plan_markdown;
      task.plan.state = "verifying";
      task = transitionTask(task, { type: "plan_completed" }, config);
      phaseStartedInThisInvocation = true;
      continue;
    }

    if (phase === "plan_verify") {
      const completed = await runCompletedPhase<PlanVerifyData>(
        task,
        phase,
        options,
        undefined,
        planMarkdown,
        undefined,
        { countColdRestart: !phaseStartedInThisInvocation },
      );
      phaseStartedInThisInvocation = false;
      if (!completed.ok) {
        return { task: completed.task, planMarkdown, verifierFindings };
      }
      task = completed.task;
      verifierFindings = completed.data.findings;
      if (completed.data.result === "ok") {
        task = transitionTask(task, { type: "plan_verify_accepted" }, config);
        return { task, planMarkdown, verifierFindings };
      }
      task = transitionTask(task, { type: "plan_verify_rejected" }, config);
      phaseStartedInThisInvocation = true;
      if (task.state === "failed") {
        return { task, planMarkdown, verifierFindings };
      }
      continue;
    }

    const completed = await runCompletedPhase<PlanFixData>(
      task,
      phase,
      options,
      undefined,
      planMarkdown,
      undefined,
      { countColdRestart: !phaseStartedInThisInvocation },
    );
    phaseStartedInThisInvocation = false;
    if (!completed.ok) {
      return { task: completed.task, planMarkdown, verifierFindings };
    }
    task = completed.task;
    planMarkdown = completed.data.plan_markdown;
    task = transitionTask(task, { type: "plan_fix_completed" }, config);
    phaseStartedInThisInvocation = true;
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

  const reviewCompleted = await runCompletedPhase<ReviewData>(
    task,
    "review",
    options,
    undefined,
    undefined,
    undefined,
    { countColdRestart: task.git.checkpoints.review.before_sha !== null },
  );
  if (!reviewCompleted.ok) {
    return { task: reviewCompleted.task, findings, acceptedIds: [], rejectedIds: [] };
  }
  task = reviewCompleted.task;
  findings = assignFindingIds(sanitizeReviewFindings(reviewCompleted.data.findings, options));
  task = transitionTask(task, { type: "review_completed" }, config);

  if (findings.length === 0 || everyFindingAlreadyRejected(task, findings)) {
    task = transitionTask(task, { type: "supervise_no_findings" }, config);
    return { task, findings, acceptedIds: [], rejectedIds: [] };
  }

  const superviseCompleted = await runCompletedPhase<SuperviseData>(
    task,
    "supervise",
    options,
    findings,
    undefined,
    (data, nextTask) =>
      validateSupervisorDecision(sanitizeSuperviseData(data, options), findings, nextTask),
    { countColdRestart: task.git.checkpoints.supervise.before_sha !== null },
  );
  if (!superviseCompleted.ok) {
    return { task: superviseCompleted.task, findings, acceptedIds: [], rejectedIds: [] };
  }
  task = superviseCompleted.task;
  const superviseDecision = sanitizeSuperviseData(superviseCompleted.data, options);

  const decisionRound = task.review_round + 1;
  task.review_findings.push({
    round: decisionRound,
    accept_ids: [...superviseDecision.accept_ids],
    reject_ids: [...superviseDecision.reject_ids],
    reject_reasons: { ...superviseDecision.reject_reasons },
  });
  upsertRejectHistory(task, findings, superviseDecision, decisionRound);

  if (superviseDecision.accept_ids.length > 0) {
    task = transitionTask(task, { type: "supervise_accept", origin: "review" }, config);
    return {
      task,
      findings,
      acceptedIds: superviseDecision.accept_ids,
      rejectedIds: superviseDecision.reject_ids,
      fixPrompt: superviseDecision.fix_prompt,
    };
  }

  task = transitionTask(task, { type: "supervise_reject_all" }, config);
  return {
    task,
    findings,
    acceptedIds: [],
    rejectedIds: superviseDecision.reject_ids,
  };
}

export async function runImplementWorkflow(
  inputTask: TaskEntry,
  options: ImplementFixWorkflowOptions,
): Promise<ImplementFixWorkflowResult> {
  let task = cloneTask(inputTask);
  let phaseStartedInThisInvocation = false;

  if (task.state === "planned" && task.runtime_phase === null && task.plan.state === "verified") {
    const beforeSha = await options.git.getHeadSha();
    task.git.base_sha ??= beforeSha;
    task = transitionTask(task, { type: "implement_started", beforeSha: beforeSha });
    phaseStartedInThisInvocation = true;
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
    const completed = await runCompletedPhase<ImplementData>(
      task,
      "implement",
      options,
      undefined,
      undefined,
      undefined,
      { countColdRestart: !phaseStartedInThisInvocation },
    );
    if (!completed.ok) {
      return { task: completed.task, changedFiles: [], testsRun: [] };
    }
    task = completed.task;
    changedFiles = completed.data.changed_files;
    testsRun = completed.data.tests_run;
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
  let phaseStartedInThisInvocation = false;

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
    phaseStartedInThisInvocation = true;
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
    const completed = await runCompletedPhase<FixData>(
      task,
      "fix",
      options,
      undefined,
      undefined,
      undefined,
      { countColdRestart: !phaseStartedInThisInvocation },
    );
    if (!completed.ok) {
      return { task: completed.task, changedFiles: [], testsRun: [] };
    }
    task = completed.task;
    changedFiles = completed.data.changed_files;
    testsRun = completed.data.tests_run;
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
      const message = sanitizeWorkflowString(
        `branch cleanup incomplete: ${deleted.message}`,
        options,
      );
      return {
        task: transitionTask(task, {
          type: "cleaning_branch_failed",
          message,
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

type RunPhaseOptions = {
  countColdRestart?: boolean;
};

async function runCompletedPhase<T>(
  task: TaskEntry,
  phase: Phase,
  options: WorkflowOptions,
  currentFindings?: ReviewFindingWithId[],
  planMarkdown?: string,
  validate?: (data: T, task: TaskEntry) => string[],
  runOptions?: RunPhaseOptions,
): Promise<CompletedPhaseResult<T>> {
  let currentTask = task;

  for (;;) {
    const runnerResult = await runPhase(
      currentTask,
      phase,
      options,
      currentFindings,
      planMarkdown,
      runOptions,
    );
    if (!runnerResult.ok) {
      return { ok: false, task: runnerResult.task };
    }

    currentTask = runnerResult.task;
    const handled = handleNonCompletedOutput(currentTask, phase, runnerResult.output, options);
    if (handled !== null) {
      return { ok: false, task: handled };
    }

    const data = requireStructuredData<T>(runnerResult.output, phase);
    if (!data.ok) {
      const corrected = await runWithSelfCorrection(currentTask, phase, data.message, options);
      if (!corrected.ok) {
        return { ok: false, task: corrected.task };
      }
      currentTask = corrected.task;
      continue;
    }

    const validationErrors = validate?.(data.value, currentTask) ?? [];
    if (validationErrors.length > 0) {
      const corrected = await runWithSelfCorrection(
        currentTask,
        phase,
        validationErrors.join("; "),
        options,
      );
      if (!corrected.ok) {
        return { ok: false, task: corrected.task };
      }
      currentTask = corrected.task;
      continue;
    }

    return { ok: true, task: currentTask, output: runnerResult.output, data: data.value };
  }
}

function buildAgentRunInput(
  task: TaskEntry,
  phase: Phase,
  options: WorkflowOptions,
  currentFindings?: ReviewFindingWithId[],
  planMarkdown?: string,
  questionResponse?: AgentRunInput["questionResponse"],
): AgentRunInput {
  const config = options.config ?? DEFAULT_CONFIG;
  const provider = effectiveProviderForPhase(task, phase, config);
  const capability = validateCapabilitySelection({ phase, provider });
  const effectivePermission = effectivePermissionFor(capability.phase, provider, config);
  const workspaceScope =
    phase === "review" || phase === "supervise" || phase === "implement" || phase === "fix"
      ? "worktree"
      : "repo";
  const mode = phase === "implement" || phase === "fix" ? "workspace-write" : "readonly";
  const resolvedEffort = requireResolvedEffort(task, phase);
  return {
    provider,
    phase,
    cwd:
      workspaceScope === "worktree" ? (options.worktreeRoot ?? options.repoRoot) : options.repoRoot,
    prompt:
      options.buildPrompt?.({ task, phase, planMarkdown, currentFindings }) ??
      defaultPrompt(task, phase),
    promptContract: promptContractForPhase(phase),
    model: task.runtime.resolved_model[phase] ?? "auto",
    effort: resolvedEffort,
    effective_permission: effectivePermission,
    resume: resumeForPhase(task, phase, provider),
    questionResponse,
    permissions: {
      mode,
      allowNetwork: false,
      workspaceScope,
      workspaceRoot:
        workspaceScope === "worktree"
          ? (options.worktreeRoot ?? options.repoRoot)
          : options.repoRoot,
      homeIsolation:
        provider === "claude"
          ? config.permissions.claude.home_isolation
          : config.permissions.codex.home_isolation,
    },
    timeoutMs: options.timeoutMs ?? resolvedEffort.timeout_ms,
  };
}

function defaultPrompt(task: TaskEntry, phase: RuntimePhase): string {
  return [
    `Issue #${task.issue}: ${task.title}`,
    `runtime_phase: ${phase}`,
    "Follow the configured prompt_contract and return structured output only.",
  ].join("\n");
}

function resumeForPhase(
  task: TaskEntry,
  phase: Phase,
  provider: Provider,
): AgentRunInput["resume"] | undefined {
  const session = task.provider_sessions[phase];
  if (provider === "claude") {
    return session.claude_session_id ? { claudeSessionId: session.claude_session_id } : undefined;
  }
  return session.codex_session_id ? { codexSessionId: session.codex_session_id } : undefined;
}

function effectiveProviderForPhase(task: TaskEntry, phase: Phase, config: AutokitConfig): Provider {
  if (
    task.runtime.phase_override?.phase === phase &&
    task.runtime.phase_override.provider !== undefined
  ) {
    return task.runtime.phase_override.provider;
  }
  return task.provider_sessions[phase].last_provider ?? config.phases[phase].provider;
}

function effectiveEffortForPhase(
  task: TaskEntry,
  phase: Phase,
  config: AutokitConfig,
): EffortLevel {
  if (
    task.runtime.phase_override?.phase === phase &&
    task.runtime.phase_override.effort !== undefined
  ) {
    return task.runtime.phase_override.effort;
  }
  return config.phases[phase].effort ?? config.effort.default;
}

function effectivePermissionFor(
  phase: Phase,
  provider: Provider,
  config: AutokitConfig,
): EffectivePermission {
  const row = validateCapabilitySelection({ phase, provider });
  return provider === "claude"
    ? {
        permission_profile: row.permission_profile,
        claude: claudePermissionForConfig(phase, row.permission_profile, config),
      }
    : {
        permission_profile: row.permission_profile,
        codex: derive_codex_perm(phase),
      };
}

function claudePermissionForConfig(
  phase: Phase,
  profile: PermissionProfile,
  config: AutokitConfig,
) {
  const permission = derive_claude_perm(phase);
  if (profile === "write_worktree") {
    return permission;
  }
  const allowed = permission.allowed_tools.filter((tool) =>
    config.permissions.claude.allowed_tools.includes(tool),
  );
  const denied = Array.from(
    new Set([
      ...permission.denied_tools,
      ...permission.allowed_tools.filter((tool) => !allowed.includes(tool)),
    ]),
  );
  return { ...permission, allowed_tools: allowed, denied_tools: denied };
}

function requireResolvedEffort(
  task: TaskEntry,
  phase: Phase,
): NonNullable<TaskEntry["runtime"]["resolved_effort"]> {
  if (task.runtime.resolved_effort?.phase !== phase) {
    throw new Error(`resolved effort missing for phase: ${phase}`);
  }
  return task.runtime.resolved_effort;
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
  phase: Phase,
  options: WorkflowOptions,
  currentFindings?: ReviewFindingWithId[],
  planMarkdown?: string,
  runOptions: RunPhaseOptions = {},
): Promise<{ ok: true; task: TaskEntry; output: AgentRunOutput } | { ok: false; task: TaskEntry }> {
  let currentTask = task;
  let questionResponse: AgentRunInput["questionResponse"];
  let coldRestartChecked = false;
  for (let turn = 0; turn < 3; turn += 1) {
    try {
      currentTask = await ensureSimplePhaseBeforeCheckpoint(currentTask, phase, options);
      currentTask = await resolveAndPersistEffort(currentTask, phase, options);
      if (currentTask.state === "failed" || currentTask.state === "paused") {
        return { ok: false, task: currentTask };
      }
      if (!coldRestartChecked) {
        coldRestartChecked = true;
        const prepared = await prepareColdRestartAttempt(currentTask, phase, options, runOptions);
        if (!prepared.ok) {
          return { ok: false, task: prepared.task };
        }
        currentTask = prepared.task;
      }
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
      currentTask = await resetPhaseAttemptAfterRunnerProgress(currentTask, options);
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
      if (failureCodeFromError(error) === "prompt_contract_violation") {
        const message = error instanceof Error ? error.message : "prompt contract violation";
        const corrected = await runWithSelfCorrection(currentTask, phase, message, options);
        if (!corrected.ok) {
          return { ok: false, task: corrected.task };
        }
        currentTask = corrected.task;
        questionResponse = undefined;
        continue;
      }
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

async function ensureSimplePhaseBeforeCheckpoint(
  task: TaskEntry,
  phase: Phase,
  options: WorkflowOptions,
): Promise<TaskEntry> {
  if (!isSimpleCheckpointPhase(phase) || task.git.checkpoints[phase].before_sha !== null) {
    return task;
  }
  const beforeSha = await options.getHeadSha?.(phase);
  if (beforeSha === undefined || beforeSha.length === 0) {
    return task;
  }
  const next = cloneTask(task);
  next.git.checkpoints[phase].before_sha = beforeSha;
  await persistTask(next, options);
  return next;
}

function isSimpleCheckpointPhase(
  phase: Phase,
): phase is "plan" | "plan_verify" | "plan_fix" | "review" | "supervise" {
  return (
    phase === "plan" ||
    phase === "plan_verify" ||
    phase === "plan_fix" ||
    phase === "review" ||
    phase === "supervise"
  );
}

async function prepareColdRestartAttempt(
  task: TaskEntry,
  phase: Phase,
  options: WorkflowOptions,
  runOptions: RunPhaseOptions,
): Promise<{ ok: true; task: TaskEntry } | { ok: false; task: TaskEntry }> {
  if (runOptions.countColdRestart === false) {
    return { ok: true, task };
  }
  const config = options.config ?? DEFAULT_CONFIG;
  const provider = effectiveProviderForPhase(task, phase, config);
  if (!shouldCountColdRestart(task, phase, provider)) {
    return { ok: true, task };
  }

  const next = cloneTask(task);
  next.runtime.phase_attempt += 1;
  if (next.runtime.phase_attempt >= 3) {
    const failed = failWorkflow(
      next,
      phase,
      "phase_attempt_exceeded",
      `cold restart exceeded for phase: ${phase}`,
      options,
    ).task;
    await persistTask(failed, options);
    return { ok: false, task: failed };
  }

  await persistTask(next, options);
  return { ok: true, task: next };
}

function shouldCountColdRestart(task: TaskEntry, phase: Phase, provider: Provider): boolean {
  if (resumeForPhase(task, phase, provider) !== undefined) {
    return false;
  }
  const checkpoint = task.git.checkpoints[phase];
  if (checkpoint.before_sha === null) {
    return false;
  }
  if ("agent_done" in checkpoint) {
    return checkpoint.agent_done === null;
  }
  return checkpoint.after_sha === null;
}

async function resetPhaseAttemptAfterRunnerProgress(
  task: TaskEntry,
  options: WorkflowOptions,
): Promise<TaskEntry> {
  if (task.runtime.phase_attempt === 0) {
    return task;
  }
  const next = cloneTask(task);
  next.runtime.phase_attempt = 0;
  await persistTask(next, options);
  return next;
}

async function resolveAndPersistEffort(
  task: TaskEntry,
  phase: Phase,
  options: WorkflowOptions,
): Promise<TaskEntry> {
  const config = options.config ?? DEFAULT_CONFIG;
  const provider = effectiveProviderForPhase(task, phase, config);
  const effort = effectiveEffortForPhase(task, phase, config);
  const timeoutMs = resolveRunnerTimeout(config, phase, {
    phase,
    provider,
    effort,
    downgraded_from: null,
    timeout_ms: timeoutMsForEffort(effort),
  });
  const result = resolveEffort({
    phase,
    provider,
    effort,
    model: task.runtime.resolved_model[phase] ?? config.phases[phase].model,
    unsupported_policy: config.effort.unsupported_policy,
    timeout_ms: timeoutMs,
  });
  if (!result.ok) {
    return failWorkflow(task, phase, result.failure.code, result.failure.message, options).task;
  }
  const finalTimeoutMs = resolveRunnerTimeout(config, phase, {
    ...result.resolved,
    timeout_ms: timeoutMsForEffort(result.resolved.effort),
  });
  const resolved = { ...result.resolved, timeout_ms: finalTimeoutMs };
  const currentSession = task.provider_sessions[phase];
  if (
    resolvedEffortEquals(task.runtime.resolved_effort, resolved) &&
    currentSession.last_provider === provider
  ) {
    if (resolved.downgraded_from !== null) {
      emitEffortDowngradeAudit(
        {
          kind: "effort_downgrade",
          phase: resolved.phase,
          provider: resolved.provider,
          model: task.runtime.resolved_model[phase] ?? config.phases[phase].model,
          from: resolved.downgraded_from,
          to: resolved.effort,
        },
        options,
      );
    }
    return task;
  }

  const next = cloneTask(task);
  next.runtime.resolved_effort = resolved;
  next.provider_sessions[phase].last_provider = provider;
  await persistTask(next, options);
  if (result.audit !== null) {
    emitEffortDowngradeAudit(result.audit, options);
  }
  return next;
}

function emitEffortDowngradeAudit(
  audit: {
    kind: "effort_downgrade";
    phase: Phase;
    provider: Provider;
    model: string;
    from: EffortLevel;
    to: EffortLevel;
  },
  options: WorkflowOptions,
): void {
  options.auditOperation?.(audit.kind, {
    phase: audit.phase,
    provider: audit.provider,
    model: sanitizeWorkflowString(audit.model, options),
    from: audit.from,
    to: audit.to,
  });
}

function resolvedEffortEquals(
  actual: TaskEntry["runtime"]["resolved_effort"],
  expected: NonNullable<TaskEntry["runtime"]["resolved_effort"]>,
): boolean {
  return (
    actual !== null &&
    actual.phase === expected.phase &&
    actual.provider === expected.provider &&
    actual.effort === expected.effort &&
    actual.downgraded_from === expected.downgraded_from &&
    actual.timeout_ms === expected.timeout_ms
  );
}

function timeoutMsForEffort(effort: EffortLevel): number {
  switch (effort) {
    case "low":
      return 1_200_000;
    case "high":
      return 3_600_000;
    case "auto":
    case "medium":
      return 1_800_000;
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

async function runWithSelfCorrection(
  task: TaskEntry,
  phase: RuntimePhase,
  message: string,
  options: WorkflowOptions,
): Promise<{ ok: true; task: TaskEntry } | { ok: false; task: TaskEntry }> {
  if (task.runtime.phase_self_correct_done === true) {
    return { ok: false, task: failPromptContract(task, phase, message, options) };
  }

  const next = cloneTask(task);
  next.runtime.phase_self_correct_done = true;
  await persistTask(next, options);
  options.auditOperation?.("phase_self_correct", {
    issue: next.issue,
    phase,
    reason: sanitizeWorkflowString(message, options),
  });
  return { ok: true, task: next };
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
  const sanitizedMessage = sanitizeWorkflowString(message, options);
  return {
    task: transitionTask(task, {
      type: "fail",
      failure: makeFailure({ phase, code, message: sanitizedMessage, ts: options.now?.() }),
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
  const sanitizedMessage = sanitizeWorkflowString(message, options);
  return transitionTask(task, {
    type: "pause",
    failure: makeFailure({ phase, code, message: sanitizedMessage, ts: options.now?.() }),
  });
}

function sanitizeWorkflowString(value: string, options: WorkflowOptions): string {
  return sanitizeLogString(value, options.config ?? DEFAULT_CONFIG, false, {
    homeDir: options.homeDir ?? process.env.HOME,
    repoRoot: options.repoRoot,
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

function sanitizeReviewFindings(
  findings: ReviewFinding[],
  options: WorkflowOptions,
): ReviewFinding[] {
  return findings.map((finding) => ({
    ...finding,
    file: sanitizeWorkflowString(finding.file, options),
    title: sanitizeWorkflowString(finding.title, options),
    rationale: sanitizeWorkflowString(finding.rationale, options),
    suggested_fix: sanitizeWorkflowString(finding.suggested_fix, options),
  }));
}

function sanitizeSuperviseData(data: SuperviseData, options: WorkflowOptions): SuperviseData {
  return {
    ...data,
    reject_reasons: Object.fromEntries(
      Object.entries(data.reject_reasons).map(([id, reason]) => [
        id,
        sanitizeWorkflowString(reason, options),
      ]),
    ),
    fix_prompt:
      data.fix_prompt === undefined ? undefined : sanitizeWorkflowString(data.fix_prompt, options),
  };
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
      const sanitizedMessage = sanitizeWorkflowString(
        `worktree cleanup incomplete after ${next.cleaning_progress.worktree_remove_attempts} attempts: ${message}`,
        options,
      );
      return {
        ok: false,
        task: transitionTask(next, {
          type: "cleaning_worktree_failed",
          message: sanitizedMessage,
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
