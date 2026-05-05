import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runClaude } from "@cattyneo/autokit-claude-runner";
import { runCodex } from "@cattyneo/autokit-codex-runner";
import {
  type AgentRunInput,
  type AgentRunOutput,
  type AutokitConfig,
  type AutokitLogger,
  buildAutoMergeArgs,
  buildDisableAutoMergeArgs,
  buildGhEnv,
  buildGhIssueViewBodyArgs,
  buildGhPrCreateDraftArgs,
  buildGhPrListHeadArgs,
  buildGhPrReadyArgs,
  buildGhPrViewArgs,
  buildGhPrViewCiArgs,
  buildGhPrViewHeadArgs,
  buildGhPrViewMergeArgs,
  buildGitAddAllArgs,
  buildGitCommitArgs,
  buildGitFetchArgs,
  buildGitPushSetUpstreamArgs,
  buildGitRebaseArgs,
  buildGitRemoteBranchDeleteArgs,
  buildGitRevParseHeadArgs,
  buildGitWorktreeAddArgs,
  buildGitWorktreeAddExistingBranchArgs,
  buildGitWorktreePruneArgs,
  buildGitWorktreeRemoveArgs,
  cloneTask,
  createAutokitLogger,
  DEFAULT_CONFIG,
  loadTasksFile,
  parseConfigYaml,
  parseGhMergeability,
  parseGhPrView,
  type RuntimePhase,
  type TaskEntry,
  type TasksFile,
  writeTasksFileAtomic,
} from "@cattyneo/autokit-core";
import {
  type BranchPrLookup,
  type CiCheckObservation,
  type CiWaitPrObservation,
  runCiWaitWorkflow,
  runCleaningWorkflow,
  runFixWorkflow,
  runImplementWorkflow,
  runMergeWorkflow,
  runPlanningWorkflow,
  runReviewSuperviseWorkflow,
  type WorkflowQuestionInput,
  type WorkflowRunner,
} from "@cattyneo/autokit-workflows";

export type WorkflowExecFile = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => string;

export type RunProductionWorkflowOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  answerQuestion?: (input: WorkflowQuestionInput) => Promise<string> | string;
  execFile?: WorkflowExecFile;
  runner?: WorkflowRunner;
  maxSteps?: number;
  now?: () => string;
};

const DEFAULT_MAX_STEPS = 100;
const API_KEY_ENV_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"] as const;

export async function runProductionWorkflow(
  options: RunProductionWorkflowOptions,
): Promise<TaskEntry[]> {
  assertApiKeyEnvUnset(options.env);
  const tasksFilePath = tasksPath(options.cwd);
  if (!existsSync(tasksFilePath)) {
    return [];
  }

  let logger: AutokitLogger | undefined;
  try {
    const config = loadConfig(options.cwd);
    logger = createWorkflowLogger(options.cwd, config, options.now);
    const execFile = options.execFile ?? defaultExecFile(options.cwd, options.env);
    const tasksFile = loadTasksFile(tasksFilePath);
    let task = selectActiveTask(tasksFile.tasks);
    if (task === undefined) {
      return tasksFile.tasks;
    }

    const issueContext = createIssueContextLoader(task.issue, options.cwd, execFile, logger);
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    for (let step = 0; step < maxSteps; step += 1) {
      if (isTerminalOrWaiting(task)) {
        break;
      }

      if (task.state === "queued" || task.state === "planning") {
        const result = await runPlanningWorkflow(task, {
          config,
          repoRoot: options.cwd,
          timeoutMsForPhase: (phase) => phaseTimeoutMs(config, phase),
          runner: options.runner ?? defaultRunner(options.env),
          answerQuestion: options.answerQuestion,
          persistTask: (next) => persistTask(tasksFilePath, tasksFile, next),
          buildPrompt: (input) =>
            buildPrompt(
              options.cwd,
              input.task,
              input.phase,
              issueContext(),
              input.currentFindings,
              input.planMarkdown,
            ),
        });
        if (result.planMarkdown !== undefined) {
          writePlan(options.cwd, result.task, result.planMarkdown);
        }
        task = result.task;
        persistTask(tasksFilePath, tasksFile, task);
        continue;
      }

      if (task.state === "planned" || task.state === "implementing") {
        ensureWorktree(options.cwd, task, config, execFile);
        const result = await runImplementWorkflow(task, {
          config,
          repoRoot: options.cwd,
          worktreeRoot: worktreePath(options.cwd, task),
          timeoutMsForPhase: (phase) => phaseTimeoutMs(config, phase),
          runner: options.runner ?? defaultRunner(options.env),
          answerQuestion: options.answerQuestion,
          persistTask: (next) => persistTask(tasksFilePath, tasksFile, next),
          buildPrompt: (input) =>
            buildPrompt(
              options.cwd,
              input.task,
              input.phase,
              issueContext(),
              input.currentFindings,
              input.planMarkdown,
            ),
          git: createGitDeps(options.cwd, task, config, execFile),
        });
        task = result.task;
        persistTask(tasksFilePath, tasksFile, task);
        continue;
      }

      if (task.state === "reviewing") {
        const result = await runReviewSuperviseWorkflow(task, {
          config,
          repoRoot: options.cwd,
          worktreeRoot: worktreePath(options.cwd, task),
          timeoutMsForPhase: (phase) => phaseTimeoutMs(config, phase),
          runner: options.runner ?? defaultRunner(options.env),
          answerQuestion: options.answerQuestion,
          persistTask: (next) => persistTask(tasksFilePath, tasksFile, next),
          buildPrompt: (input) =>
            buildPrompt(
              options.cwd,
              input.task,
              input.phase,
              issueContext(),
              input.currentFindings,
              input.planMarkdown,
            ),
        });
        writeReviewArtifact(options.cwd, result.task, result.findings);
        task = result.task;
        persistTask(tasksFilePath, tasksFile, task);
        continue;
      }

      if (task.state === "fixing") {
        ensureWorktree(options.cwd, task, config, execFile);
        const result = await runFixWorkflow(task, {
          config,
          repoRoot: options.cwd,
          worktreeRoot: worktreePath(options.cwd, task),
          timeoutMsForPhase: (phase) => phaseTimeoutMs(config, phase),
          runner: options.runner ?? defaultRunner(options.env),
          answerQuestion: options.answerQuestion,
          persistTask: (next) => persistTask(tasksFilePath, tasksFile, next),
          buildPrompt: (input) =>
            buildPrompt(
              options.cwd,
              input.task,
              input.phase,
              issueContext(),
              input.currentFindings,
              input.planMarkdown,
            ),
          git: createGitDeps(options.cwd, task, config, execFile),
        });
        task = result.task;
        persistTask(tasksFilePath, tasksFile, task);
        continue;
      }

      if (task.state === "ci_waiting") {
        const result = await runCiWaitWorkflow(task, {
          config,
          repoRoot: options.cwd,
          runner: options.runner ?? defaultRunner(options.env),
          persistTask: (next) => persistTask(tasksFilePath, tasksFile, next),
          github: createCiDeps(execFile, options.cwd, logger),
        });
        task = result.task;
        persistTask(tasksFilePath, tasksFile, task);
        continue;
      }

      if (task.state === "merging") {
        const result = await runMergeWorkflow(task, {
          config,
          repoRoot: options.cwd,
          runner: options.runner ?? defaultRunner(options.env),
          persistTask: (next) => persistTask(tasksFilePath, tasksFile, next),
          github: createMergeDeps(execFile, options.cwd, logger),
        });
        task = result.task;
        persistTask(tasksFilePath, tasksFile, task);
        continue;
      }

      if (task.state === "cleaning") {
        const result = await runCleaningWorkflow(task, {
          config,
          repoRoot: options.cwd,
          runner: options.runner ?? defaultRunner(options.env),
          persistTask: (next) => persistTask(tasksFilePath, tasksFile, next),
          cleanup: createCleanupDeps(execFile, options.cwd, logger),
        });
        task = result.task;
        persistTask(tasksFilePath, tasksFile, task);
        continue;
      }

      break;
    }

    return tasksFile.tasks;
  } finally {
    logger?.close();
  }
}

function assertApiKeyEnvUnset(env: NodeJS.ProcessEnv): void {
  const present = API_KEY_ENV_NAMES.filter((name) => env[name] !== undefined && env[name] !== "");
  if (present.length > 0) {
    throw new Error(`${present.join(",")} must not be exported`);
  }
}

function defaultExecFile(cwd: string, env: NodeJS.ProcessEnv): WorkflowExecFile {
  return (command, args, options) =>
    execFileSync(command, args, {
      cwd: options?.cwd ?? cwd,
      env: buildGhEnv(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
}

function defaultRunner(env: NodeJS.ProcessEnv): WorkflowRunner {
  return (input: AgentRunInput): Promise<AgentRunOutput> =>
    input.provider === "claude"
      ? runClaude(input, { parentEnv: env })
      : runCodex(input, { parentEnv: env });
}

function loadConfig(cwd: string): AutokitConfig {
  const configPath = join(cwd, ".autokit", "config.yaml");
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }
  return parseConfigYaml(readFileSync(configPath, "utf8"));
}

function createWorkflowLogger(
  cwd: string,
  config: AutokitConfig,
  now?: () => string,
): AutokitLogger {
  return createAutokitLogger({
    logDir: join(cwd, ".autokit", "logs"),
    config,
    now: now === undefined ? undefined : () => new Date(now()),
  });
}

function selectActiveTask(tasks: TaskEntry[]): TaskEntry | undefined {
  return tasks.find((task) => task.state !== "merged" && task.state !== "failed");
}

function phaseTimeoutMs(config: AutokitConfig, phase: RuntimePhase): number {
  switch (phase) {
    case "plan":
      return config.runner_timeout.plan_ms;
    case "plan_verify":
      return config.runner_timeout.plan_verify_ms ?? config.runner_timeout.default_ms;
    case "plan_fix":
      return config.runner_timeout.plan_fix_ms ?? config.runner_timeout.default_ms;
    case "implement":
      return config.runner_timeout.implement_ms;
    case "review":
      return config.runner_timeout.review_ms;
    case "supervise":
      return config.runner_timeout.supervise_ms ?? config.runner_timeout.default_ms;
    case "fix":
      return config.runner_timeout.fix_ms ?? config.runner_timeout.default_ms;
  }
}

function isTerminalOrWaiting(task: TaskEntry): boolean {
  return task.state === "merged" || task.state === "failed" || task.state === "paused";
}

function persistTask(path: string, tasksFile: TasksFile, task: TaskEntry): void {
  const index = tasksFile.tasks.findIndex((entry) => entry.issue === task.issue);
  if (index < 0) {
    throw new Error(`issue #${task.issue} not found`);
  }
  tasksFile.tasks[index] = cloneTask(task);
  tasksFile.generated_at = new Date().toISOString();
  writeTasksFileAtomic(path, tasksFile);
}

function writePlan(cwd: string, task: TaskEntry, planMarkdown: string): void {
  const planPath = join(cwd, task.plan.path);
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, planMarkdown, { mode: 0o600 });
}

function writeReviewArtifact(cwd: string, task: TaskEntry, findings: unknown[]): void {
  const round = Math.max(1, task.review_round);
  const path = join(cwd, ".autokit", "reviews", `issue-${task.issue}-review-${round}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      "---",
      `issue: ${task.issue}`,
      `review_round: ${round}`,
      `finding_count: ${findings.length}`,
      "---",
      "",
      "# Review",
      "",
      "```json",
      JSON.stringify(findings, null, 2),
      "```",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function tasksPath(cwd: string): string {
  return join(cwd, ".autokit", "tasks.yaml");
}

function baseBranch(config: AutokitConfig): string {
  return config.base_branch === "" ? "main" : config.base_branch;
}

function worktreePath(cwd: string, task: TaskEntry): string {
  if (task.worktree_path === null) {
    throw new Error(`issue #${task.issue} has no worktree_path`);
  }
  return join(cwd, task.worktree_path);
}

function requireBranch(task: TaskEntry): string {
  if (task.branch === null) {
    throw new Error(`issue #${task.issue} has no branch`);
  }
  return task.branch;
}

function ensureWorktree(
  cwd: string,
  task: TaskEntry,
  config: AutokitConfig,
  execFile: WorkflowExecFile,
): void {
  const path = worktreePath(cwd, task);
  if (existsSync(path)) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const branch = requireBranch(task);
  const base = baseBranch(config);
  execFile("git", buildGitFetchArgs("origin", base), { cwd });
  try {
    execFile(
      "git",
      buildGitWorktreeAddArgs({ worktreePath: path, branch, baseRef: `origin/${base}` }),
      { cwd },
    );
  } catch (error) {
    if (!String(error).includes("already exists")) {
      throw error;
    }
    execFile("git", buildGitWorktreeAddExistingBranchArgs({ worktreePath: path, branch }), { cwd });
  }
}

function createGitDeps(
  cwd: string,
  task: TaskEntry,
  config: AutokitConfig,
  execFile: WorkflowExecFile,
) {
  const wt = worktreePath(cwd, task);
  const base = baseBranch(config);
  return {
    getHeadSha: () => execFile("git", buildGitRevParseHeadArgs(), { cwd: wt }).trim(),
    stageAll: () => {
      execFile("git", buildGitAddAllArgs(), { cwd: wt });
    },
    commit: (input: { message: string }) => {
      execFile("git", buildGitCommitArgs(input.message), { cwd: wt });
      return execFile("git", buildGitRevParseHeadArgs(), { cwd: wt }).trim();
    },
    pushBranch: (branch: string) => {
      execFile("git", buildGitPushSetUpstreamArgs(branch), { cwd: wt });
    },
    findPrForBranch: (branch: string): BranchPrLookup => {
      const parsed = parseJson(execFile("gh", buildGhPrListHeadArgs(branch), { cwd }));
      const firstRaw = Array.isArray(parsed) ? parsed[0] : undefined;
      if (firstRaw === undefined) {
        return { state: "NONE" };
      }
      const first = asRecord(firstRaw);
      return {
        state: parsePrState(first.state),
        number: Number(first.number),
        headSha: first.headRefOid === undefined ? null : String(first.headRefOid),
        baseSha: first.baseRefOid === undefined ? null : String(first.baseRefOid),
      };
    },
    createDraftPr: (input: { task: TaskEntry; headSha: string }) => {
      const branch = requireBranch(input.task);
      const url = execFile(
        "gh",
        buildGhPrCreateDraftArgs({
          title: input.task.title,
          body: `Closes #${input.task.issue}\n\nCreated by autokit.`,
          head: branch,
          base,
        }),
        { cwd },
      ).trim();
      const match = url.match(/\/pull\/(\d+)/);
      if (match?.[1] !== undefined) {
        return Number(match[1]);
      }
      const lookup = parseJson(execFile("gh", buildGhPrListHeadArgs(branch), { cwd }));
      if (Array.isArray(lookup) && lookup[0]?.number !== undefined) {
        return Number(lookup[0].number);
      }
      throw new Error(`unable to determine PR number for ${branch}`);
    },
    getPrHead: (prNumber: number) => {
      const view = asRecord(parseJson(execFile("gh", buildGhPrViewHeadArgs(prNumber), { cwd })));
      return {
        headSha: String(view.headRefOid),
        baseSha: view.baseRefOid === undefined ? null : String(view.baseRefOid),
      };
    },
    markPrReady: (prNumber: number) => {
      execFile("gh", buildGhPrReadyArgs(prNumber), { cwd });
    },
    rebaseOntoBase: () => {
      try {
        execFile("git", buildGitFetchArgs("origin", base), { cwd: wt });
        execFile("git", buildGitRebaseArgs(`origin/${base}`), { cwd: wt });
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, message: String(error) };
      }
    },
  };
}

function createCiDeps(execFile: WorkflowExecFile, cwd: string, logger: AutokitLogger) {
  return {
    getChecks: (prNumber: number): CiCheckObservation => parseCiChecks(execFile, cwd, prNumber),
    getPr: (prNumber: number): CiWaitPrObservation => parseCiPr(execFile, cwd, prNumber),
    reserveAutoMerge: (input: { prNumber: number; headSha: string }) => {
      execFile("gh", buildAutoMergeArgs(input.prNumber, input.headSha), { cwd });
      logger.auditOperation("auto_merge_reserved", {
        prNumber: input.prNumber,
        headSha: input.headSha,
      });
    },
    disableAutoMerge: (prNumber: number) => {
      execFile("gh", buildDisableAutoMergeArgs(prNumber), { cwd });
      logger.auditOperation("auto_merge_disabled", { prNumber });
    },
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(ms, 1_000));
      }),
  };
}

function createMergeDeps(execFile: WorkflowExecFile, cwd: string, logger: AutokitLogger) {
  return {
    getPr: (prNumber: number) => {
      const parsed = asRecord(parseJson(execFile("gh", buildGhPrViewArgs(prNumber), { cwd })));
      const view = parseGhPrView(parsed as Parameters<typeof parseGhPrView>[0]);
      return {
        state: view.state,
        merged: view.merged,
        headSha: view.headRefOid,
        mergeable: view.mergeable,
      };
    },
    getAutoMergeStatus: (prNumber: number) => {
      const parsed = asRecord(parseJson(execFile("gh", buildGhPrViewMergeArgs(prNumber), { cwd })));
      return { autoMergeRequest: parsed.autoMergeRequest ?? null };
    },
    disableAutoMerge: (prNumber: number) => {
      execFile("gh", buildDisableAutoMergeArgs(prNumber), { cwd });
      logger.auditOperation("auto_merge_disabled", { prNumber });
    },
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(ms, 1_000));
      }),
  };
}

function createCleanupDeps(execFile: WorkflowExecFile, cwd: string, logger: AutokitLogger) {
  return {
    deleteRemoteBranch: (branch: string) => {
      const result = commandResult(() =>
        execFile("git", buildGitRemoteBranchDeleteArgs(branch), { cwd }),
      );
      if (result.ok || isRemoteBranchAlreadyGone(result.message)) {
        logger.auditOperation("branch_deleted", { branch });
        return { ok: true as const };
      }
      return result;
    },
    removeWorktree: (path: string, options: { force: boolean }) =>
      commandResult(() => execFile("git", buildGitWorktreeRemoveArgs(path, options), { cwd })),
    pruneWorktrees: () =>
      commandResult(() => execFile("git", buildGitWorktreePruneArgs(), { cwd })),
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(ms, 1_000));
      }),
  };
}

function commandResult(run: () => unknown): { ok: true } | { ok: false; message: string } {
  try {
    run();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

function isRemoteBranchAlreadyGone(message: string): boolean {
  return message.includes("remote ref does not exist");
}

function parseCiChecks(
  execFile: WorkflowExecFile,
  cwd: string,
  prNumber: number,
): CiCheckObservation {
  const view = asRecord(parseJson(execFile("gh", buildGhPrViewCiArgs(prNumber), { cwd })));
  const checks = Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : [];
  if (checks.length === 0) {
    return { status: "pending" };
  }
  const completed = checks.every((check) => String(asRecord(check).status) === "COMPLETED");
  if (!completed) {
    return { status: "pending" };
  }
  const failed = checks.filter((check) => {
    const conclusion = String(asRecord(check).conclusion ?? "").toUpperCase();
    return conclusion !== "SUCCESS" && conclusion !== "SKIPPED";
  });
  return failed.length === 0
    ? { status: "success" }
    : {
        status: "failure",
        failedLog: failed.map((check) => String(asRecord(check).name)).join(", "),
      };
}

function parseCiPr(execFile: WorkflowExecFile, cwd: string, prNumber: number): CiWaitPrObservation {
  const view = asRecord(parseJson(execFile("gh", buildGhPrViewMergeArgs(prNumber), { cwd })));
  return {
    headSha: view.headRefOid === undefined ? null : String(view.headRefOid),
    mergeable: parseGhMergeability(view),
    autoMergeRequest: view.autoMergeRequest ?? null,
  };
}

function createIssueContextLoader(
  issue: number,
  cwd: string,
  execFile: WorkflowExecFile,
  logger: AutokitLogger,
): () => string {
  let cached: string | undefined;
  return () => {
    if (cached !== undefined) {
      return cached;
    }
    cached = execFile("gh", buildGhIssueViewBodyArgs(issue), { cwd });
    logger.auditOperation("sanitize_pass_hmac", {
      issue,
      source: "issue_context",
      sanitize_hmac: createSanitizeHmac(cwd, cached),
    });
    return cached;
  };
}

function createSanitizeHmac(cwd: string, text: string): string {
  const key = readFileSync(join(cwd, ".autokit", "audit-hmac-key"));
  return createHmac("sha256", key).update(text).digest("hex");
}

function buildPrompt(
  cwd: string,
  task: TaskEntry,
  phase: RuntimePhase,
  issueContext: string,
  currentFindings?: unknown,
  planMarkdown?: string,
): string {
  const planPath = join(cwd, task.plan.path);
  const plan = planMarkdown ?? (existsSync(planPath) ? readFileSync(planPath, "utf8") : "");
  const phasePrompt = readPhasePrompt(cwd, phase);
  return [
    phasePrompt,
    "",
    `Issue #${task.issue}: ${task.title}`,
    `runtime_phase: ${phase}`,
    "Return structured output for the configured prompt_contract only.",
    "",
    "Issue context JSON:",
    issueContext || "{}",
    "",
    "Current plan:",
    plan || "(none yet)",
    "",
    currentFindings === undefined
      ? ""
      : `Current findings JSON:\n${JSON.stringify(currentFindings)}`,
  ].join("\n");
}

function readPhasePrompt(cwd: string, phase: RuntimePhase): string {
  const promptPath = join(cwd, ".agents", "prompts", `${promptFileNameForPhase(phase)}.md`);
  return existsSync(promptPath) ? readFileSync(promptPath, "utf8").trim() : "";
}

function promptFileNameForPhase(phase: RuntimePhase): string {
  switch (phase) {
    case "plan":
      return "plan";
    case "plan_verify":
      return "plan-verify";
    case "plan_fix":
      return "plan-fix";
    case "implement":
      return "implement";
    case "review":
      return "review";
    case "supervise":
      return "supervise";
    case "fix":
      return "fix";
  }
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected JSON object");
  }
  return value as Record<string, unknown>;
}

function parsePrState(value: unknown): "OPEN" | "MERGED" | "CLOSED" {
  if (value === "OPEN" || value === "MERGED" || value === "CLOSED") {
    return value;
  }
  throw new Error(`unexpected PR state: ${String(value)}`);
}
