import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildGhEnv,
  buildGhPrCloseArgs,
  buildGhPrViewArgs,
  buildGitBranchDeleteArgs,
  buildGitWorktreeRemoveArgs,
  createTaskEntry,
  type GhPrView,
  loadTasksFile,
  makeFailure,
  type PromptContractQuestion,
  parseConfigYaml,
  parseGhPrView,
  type RuntimePhase,
  retryCleanupTask,
  type TaskEntry,
  type TasksFile,
  writeTasksFileAtomic,
} from "@cattyneo/autokit-core";
import {
  createNeedInputAutoAnswer,
  formatRunFrame,
  promptQuestion,
  type TuiTaskSummary,
} from "@cattyneo/autokit-tui";
import { Command, CommanderError } from "commander";

export const AUTOKIT_VERSION = "0.1.0";
export const TEMPFAIL_EXIT_CODE = 75;

export type CliWriter = { write(chunk: string): void };

export type ExecFile = (command: string, args: string[], options?: { cwd?: string }) => string;

export type IssueMetadata = {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
};

export type CliDeps = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: CliWriter;
  stderr: CliWriter;
  execFile?: ExecFile;
  now?: () => string;
  fetchIssue?: (issue: number) => IssueMetadata | null;
  fetchOpenIssues?: () => IssueMetadata[];
  confirm?: (message: string) => boolean;
  runWorkflow?: (input: {
    yes: boolean;
    answerQuestion: (input: CliQuestionInput) => Promise<string> | string;
  }) => Promise<TaskEntry[]> | TaskEntry[];
  askQuestion?: (input: CliQuestionInput) => Promise<string> | string;
};

export type CliQuestionInput = {
  task: TaskEntry;
  phase: RuntimePhase;
  question: PromptContractQuestion;
  turn: number;
};

export function getAutokitVersion(): string {
  return AUTOKIT_VERSION;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let exitCode = 0;
  const program = createProgram(deps, (code) => {
    exitCode = code;
  });

  try {
    await program.parseAsync(["node", "autokit", ...argv], { from: "node" });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return exitCode;
}

export function getWorkflowExitCode(tasks: TaskEntry[]): number {
  if (tasks.some((task) => task.state === "failed")) {
    return 1;
  }
  if (tasks.some((task) => task.state === "paused" || task.state === "cleaning")) {
    return TEMPFAIL_EXIT_CODE;
  }
  return tasks.every((task) => task.state === "merged") ? 0 : TEMPFAIL_EXIT_CODE;
}

export function getRetryExitCode(tasks: TaskEntry[]): number {
  if (tasks.some((task) => task.state === "failed")) {
    return 1;
  }
  if (tasks.some((task) => task.state === "paused" || task.state === "cleaning")) {
    return TEMPFAIL_EXIT_CODE;
  }
  return tasks.every((task) => task.state === "queued") ? 0 : 1;
}

export function parseIssueRange(input: string): number[] | "all" {
  if (input === "all") {
    return "all";
  }
  const seen = new Set<number>();
  for (const part of input.split(",")) {
    const token = part.trim();
    if (token.length === 0) {
      throw new Error("empty issue range token");
    }
    if (token.includes("-")) {
      const [startText, endText] = token.split("-");
      const start = parsePositiveInteger(startText ?? "");
      const end = parsePositiveInteger(endText ?? "");
      if (end < start) {
        throw new Error(`invalid issue range: ${token}`);
      }
      for (let value = start; value <= end; value += 1) {
        seen.add(value);
      }
    } else {
      seen.add(parsePositiveInteger(token));
    }
  }
  return [...seen].sort((left, right) => left - right);
}

function createProgram(deps: CliDeps, setExitCode: (code: number) => void): Command {
  const program = new Command();
  program
    .name("autokit")
    .description("Issue-driven local automation runtime")
    .version(AUTOKIT_VERSION, "-V, --version")
    .option("-y, --yes", "non-interactive default answer for agent questions")
    .option("-v, --verbose", "debug log")
    .option("--config <path>", "config.yaml override")
    .option("--force-unlock", "request lock seizure after interactive confirmation")
    .exitOverride()
    .configureOutput({
      writeOut: (value) => deps.stdout.write(value),
      writeErr: (value) => deps.stderr.write(value),
    });

  program
    .command("version")
    .description("print autokit version")
    .action(() => {
      deps.stdout.write(`autokit ${AUTOKIT_VERSION}\n`);
      setExitCode(0);
    });

  program
    .command("list")
    .description("list tasks")
    .option("--json", "print machine-readable JSON")
    .action((options: { json?: boolean }) => {
      const tasksFile = loadTasksOrEmpty(deps);
      deps.stdout.write(
        options.json
          ? `${JSON.stringify(toListJson(tasksFile.tasks), null, 2)}\n`
          : renderTaskTable(tasksFile.tasks),
      );
      setExitCode(0);
    });

  program
    .command("status")
    .description("show current active task")
    .action(() => {
      const task = loadTasksOrEmpty(deps).tasks.find(
        (entry) => !["queued", "merged", "failed"].includes(entry.state),
      );
      if (task === undefined) {
        deps.stderr.write("no running task\n");
        setExitCode(1);
        return;
      }
      deps.stdout.write(`${JSON.stringify(toStatusJson(task), null, 2)}\n`);
      setExitCode(0);
    });

  program
    .command("doctor")
    .description("check local autokit prerequisites")
    .action(() => {
      const result = runDoctor(deps);
      for (const check of result.checks) {
        deps.stdout.write(`${check.status}\t${check.name}\t${check.message}\n`);
      }
      setExitCode(result.ok ? 0 : 1);
    });

  program
    .command("add")
    .description("add GitHub issues to tasks.yaml")
    .argument("<range>", "issue range: 10, 10-13, or all")
    .option("--label <name>", "require label, repeatable", collectValues, [] as string[])
    .option("--force", "re-add merged tasks")
    .option("--dry-run", "show additions without writing")
    .option("-y, --yes", "confirm selected issue additions")
    .action(
      (
        range: string,
        options: { label: string[]; force?: boolean; dryRun?: boolean; yes?: boolean },
      ) => {
        setExitCode(
          commandAdd(
            range,
            {
              ...options,
              yes: options.yes === true || program.opts<{ yes?: boolean }>().yes === true,
            },
            deps,
          ),
        );
      },
    );

  program
    .command("run")
    .description("dispatch run entrypoint without workflow internals")
    .action(async () => {
      setExitCode(
        await commandWorkflowStatus(deps, program.opts<{ yes?: boolean }>().yes === true),
      );
    });

  program
    .command("resume")
    .description("dispatch resume entrypoint without workflow internals")
    .argument("[issue]", "issue number")
    .action((issue?: string) => {
      setExitCode(commandResume(issue, deps));
    });

  program
    .command("retry")
    .description("retry failed tasks after cleanup")
    .argument("[range]", "issue range")
    .option("--recover-corruption <issue>", "recover a queue_corruption task")
    .action((range: string | undefined, options: { recoverCorruption?: string }) => {
      setExitCode(commandRetry(range, options, deps));
    });

  program
    .command("cleanup")
    .description("cleanup merged task residue")
    .requiredOption("--force-detach <issue>", "force-detach cleanup for one issue")
    .option("--dry-run", "only evaluate precondition")
    .action((options: { forceDetach: string; dryRun?: boolean }) => {
      setExitCode(commandCleanup(options, deps));
    });

  return program;
}

function commandAdd(
  range: string,
  options: { label: string[]; force?: boolean; dryRun?: boolean; yes?: boolean },
  deps: CliDeps,
): number {
  let targets: IssueMetadata[];
  try {
    const parsedRange = parseIssueRange(range);
    targets =
      parsedRange === "all"
        ? fetchOpenIssues(deps)
        : parsedRange.map((issue) => fetchIssue(deps, issue)).filter((issue) => issue !== null);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const requiredLabels = options.label ?? [];
  const tasksFile = loadTasksOrEmpty(deps);
  const additions: TaskEntry[] = [];
  let hadActiveConflict = false;
  for (const issue of targets) {
    if (issue.state !== "OPEN") {
      deps.stderr.write(`skip #${issue.number}: issue is closed\n`);
      continue;
    }
    if (!requiredLabels.every((label) => issue.labels.includes(label))) {
      deps.stderr.write(`skip #${issue.number}: missing required label\n`);
      continue;
    }
    const existing = tasksFile.tasks.filter((task) => task.issue === issue.number);
    if (existing.some((task) => task.state !== "merged")) {
      deps.stderr.write(`skip #${issue.number}: task already active\n`);
      hadActiveConflict = true;
      continue;
    }
    if (existing.length > 0 && options.force !== true) {
      deps.stderr.write(`skip #${issue.number}: merged task requires --force\n`);
      continue;
    }
    const task = createTaskEntry({
      issue: issue.number,
      slug: slugify(issue.title),
      title: issue.title,
      labels: issue.labels,
      now: now(deps),
    });
    if (existing.length > 0) {
      const suffix = `-retry-${existing.length}`;
      task.branch = `${task.branch}${suffix}`;
      task.worktree_path = `${task.worktree_path}${suffix}`;
    }
    additions.push(task);
  }

  deps.stdout.write(`targets: ${targets.length}, additions: ${additions.length}\n`);
  if (options.dryRun === true) {
    return 0;
  }
  if (
    additions.length > 0 &&
    !isYes(deps, options.yes === true) &&
    deps.confirm?.("add selected issues?") !== true
  ) {
    deps.stderr.write("confirmation required\n");
    return 1;
  }
  tasksFile.tasks.push(...additions);
  tasksFile.generated_at = now(deps);
  writeTasksFileAtomic(tasksPath(deps), tasksFile);
  return hadActiveConflict ? 1 : 0;
}

async function commandWorkflowStatus(deps: CliDeps, yes = false): Promise<number> {
  try {
    if (deps.runWorkflow !== undefined) {
      const tasks = await deps.runWorkflow({
        yes,
        answerQuestion: (input) => answerCliQuestion(input, deps, yes),
      });
      deps.stdout.write(formatRunFrame({ tasks: tasks.map(toTuiTaskSummary) }));
      return getWorkflowExitCode(tasks);
    }
    const tasks = loadTasksFile(tasksPath(deps)).tasks;
    deps.stdout.write(
      formatRunFrame({
        tasks: tasks.map(toTuiTaskSummary),
        logs: buildRunLogs(tasks, yes),
      }),
    );
    return getWorkflowExitCode(tasks);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function answerCliQuestion(
  input: CliQuestionInput,
  deps: CliDeps,
  yes: boolean,
): Promise<string> {
  if (yes) {
    const autoAnswer = createNeedInputAutoAnswer({
      text: input.question.text,
      defaultAnswer: input.question.default,
      issue: input.task.issue,
      phase: input.phase,
    });
    deps.stdout.write(`${autoAnswer.logLine.message}\n`);
    return autoAnswer.answer;
  }
  if (deps.askQuestion !== undefined) {
    return deps.askQuestion(input);
  }
  const result = await promptQuestion({
    text: input.question.text,
    defaultAnswer: input.question.default,
    issue: input.task.issue,
    phase: input.phase,
  });
  deps.stdout.write(`${result.logLine.message}\n`);
  return result.answer;
}

function commandResume(issue: string | undefined, deps: CliDeps): number {
  const tasks = loadTasksOrEmpty(deps).tasks;
  let targetIssue: number | undefined;
  try {
    targetIssue = issue === undefined ? undefined : parsePositiveInteger(issue);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (targetIssue !== undefined) {
    const explicitTarget = tasks.find((task) => task.issue === targetIssue);
    if (explicitTarget === undefined) {
      deps.stderr.write(`issue #${targetIssue} not found\n`);
      return 1;
    }
    if (explicitTarget.state !== "paused") {
      deps.stderr.write(`issue #${targetIssue} is not paused\n`);
      return 1;
    }
  }
  const target = [...tasks]
    .reverse()
    .find(
      (task) =>
        task.state === "paused" && (targetIssue === undefined || task.issue === targetIssue),
    );
  if (target?.failure?.code === "retry_cleanup_failed") {
    deps.stderr.write(`issue #${target.issue} must be retried with autokit retry\n`);
    return TEMPFAIL_EXIT_CODE;
  }
  return getWorkflowExitCode(tasks);
}

function commandRetry(
  range: string | undefined,
  options: { recoverCorruption?: string },
  deps: CliDeps,
): number {
  if (options.recoverCorruption !== undefined) {
    return commandRecoverCorruption(options.recoverCorruption, deps);
  }
  const tasksFile = loadTasksOrEmpty(deps);
  let targets: TaskEntry[];
  try {
    targets = selectRetryTargets(tasksFile.tasks, range);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  for (const target of targets) {
    let lastPersistedTask: TaskEntry | null = null;
    const result = retryCleanupTask(target, {
      closePr: (task) => {
        if (task.pr.number !== null) {
          exec(deps, "gh", buildGhPrCloseArgs(task.pr.number));
        }
      },
      removeWorktree: (task) => {
        if (task.worktree_path !== null) {
          exec(deps, "git", buildGitWorktreeRemoveArgs(task.worktree_path, { force: true }));
        }
      },
      deleteBranch: (task) => {
        if (task.branch !== null) {
          exec(deps, "git", buildGitBranchDeleteArgs(task.branch));
        }
      },
      persistTask: (task) => {
        lastPersistedTask = task;
        replaceTaskAndWrite(tasksFile, task, deps);
      },
    });
    if (lastPersistedTask !== result) {
      replaceTaskAndWrite(tasksFile, result, deps);
    }
  }
  return getRetryExitCode(
    targets.map((target) => tasksFile.tasks.find((task) => task.issue === target.issue) ?? target),
  );
}

function commandRecoverCorruption(issue: string, deps: CliDeps): number {
  let issueNumber: number;
  try {
    issueNumber = parsePositiveInteger(issue);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let tasksFile: TasksFile;
  try {
    tasksFile = loadTasksFile(tasksPath(deps), { restoreFromBackup: true });
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const target = tasksFile.tasks.find((task) => task.issue === issueNumber);
  if (target === undefined) {
    deps.stderr.write(`issue #${issueNumber} not found\n`);
    return 1;
  }
  deps.stdout.write(`recover-corruption target: #${issueNumber}\n`);
  return 0;
}

function commandCleanup(options: { forceDetach: string; dryRun?: boolean }, deps: CliDeps): number {
  let issue: number;
  try {
    issue = parsePositiveInteger(options.forceDetach);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const tasksFile = loadTasksOrEmpty(deps);
  const task = tasksFile.tasks.find((entry) => entry.issue === issue);
  if (task === undefined) {
    deps.stderr.write(`issue #${issue} not found\n`);
    return 1;
  }
  if (!isForceDetachCandidate(task)) {
    deps.stderr.write(`issue #${issue} is not a force-detach candidate\n`);
    return 1;
  }
  if (task.pr.number === null || task.pr.head_sha === null) {
    deps.stderr.write(`issue #${issue} has no PR head to verify\n`);
    return 1;
  }
  let view: GhPrView;
  try {
    view = parseGhPrView(JSON.parse(exec(deps, "gh", buildGhPrViewArgs(task.pr.number))));
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (view.state !== "MERGED" || !view.merged || view.headRefOid !== task.pr.head_sha) {
    if (options.dryRun !== true) {
      task.state = "paused";
      task.failure = makeFailure({
        phase: "cleanup",
        code: "merge_sha_mismatch",
        message: "force-detach precondition failed",
      });
      replaceTaskAndWrite(tasksFile, task, deps);
    }
    deps.stderr.write(`issue #${issue} failed force-detach precondition\n`);
    return 1;
  }
  deps.stdout.write(`force-detach precondition ok for #${issue}\n`);
  if (options.dryRun === true) {
    return 0;
  }
  if (deps.confirm?.("force-detach cleanup?") !== true) {
    deps.stderr.write("interactive confirmation required\n");
    return 1;
  }
  task.state = "merged";
  task.runtime_phase = null;
  task.cleaning_progress.grace_period_done = true;
  task.cleaning_progress.branch_deleted_done = true;
  task.cleaning_progress.worktree_removed_done = true;
  task.cleaning_progress.finalized_done = true;
  task.cleaning_progress.worktree_remove_attempts = 0;
  replaceTaskAndWrite(tasksFile, task, deps);
  return 0;
}

export type DoctorCheck = {
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  message: string;
};

export function runDoctor(deps: CliDeps): { ok: boolean; checks: DoctorCheck[] } {
  const checks: DoctorCheck[] = [];
  checks.push(checkCommand(deps, "git repo", "git", ["rev-parse", "--is-inside-work-tree"]));
  checks.push(checkCommand(deps, "gh auth", "gh", ["auth", "status"]));
  checks.push(checkEnvUnset(deps));
  checks.push(checkDotEnv(deps));
  checks.push(checkConfig(deps));
  return { ok: checks.every((check) => check.status !== "FAIL"), checks };
}

function checkCommand(deps: CliDeps, name: string, command: string, args: string[]): DoctorCheck {
  try {
    exec(deps, command, args);
    return { name, status: "PASS", message: "ok" };
  } catch (error) {
    return {
      name,
      status: "FAIL",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkEnvUnset(deps: CliDeps): DoctorCheck {
  const leaked = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].filter(
    (key) => deps.env[key] !== undefined,
  );
  return leaked.length === 0
    ? { name: "env unset", status: "PASS", message: "API keys are not exported" }
    : { name: "env unset", status: "FAIL", message: `${leaked.join(",")} must not be exported` };
}

function checkDotEnv(deps: CliDeps): DoctorCheck {
  const leakedFiles = [".env", ".env.local", ".env.development", ".env.production"].filter(
    (file) => {
      const path = join(deps.cwd, file);
      return (
        existsSync(path) && /^(ANTHROPIC_API_KEY|OPENAI_API_KEY)=/m.test(readFileSync(path, "utf8"))
      );
    },
  );
  return leakedFiles.length === 0
    ? { name: "cwd .env", status: "PASS", message: "no API keys found" }
    : { name: "cwd .env", status: "FAIL", message: `${leakedFiles.join(",")} contains API keys` };
}

function checkConfig(deps: CliDeps): DoctorCheck {
  const path = join(deps.cwd, ".autokit", "config.yaml");
  if (!existsSync(path)) {
    return { name: "config", status: "WARN", message: ".autokit/config.yaml not found" };
  }
  try {
    parseConfigYaml(readFileSync(path, "utf8"));
    return { name: "config", status: "PASS", message: "valid" };
  } catch (error) {
    return {
      name: "config",
      status: "FAIL",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function loadTasksOrEmpty(deps: CliDeps): TasksFile {
  const path = tasksPath(deps);
  if (!existsSync(path)) {
    return { version: 1, generated_at: now(deps), tasks: [] };
  }
  return loadTasksFile(path);
}

function toListJson(tasks: TaskEntry[]): Array<Record<string, unknown>> {
  return tasks.map((task) => ({
    issue: task.issue,
    state: task.state,
    runtime_phase: task.runtime_phase,
    pr: { number: task.pr.number, head_sha: task.pr.head_sha },
    branch: task.branch,
    worktree_path: task.worktree_path,
    review_round: task.review_round,
    ci_fix_round: task.ci_fix_round,
    failure: task.failure,
    updated_at: updatedAt(task),
  }));
}

function toStatusJson(task: TaskEntry): Record<string, unknown> {
  return {
    issue: task.issue,
    state: task.state,
    runtime_phase: task.runtime_phase,
    review_round: task.review_round,
    ci_fix_round: task.ci_fix_round,
    resolved_model: task.runtime.resolved_model,
    failure: task.failure,
  };
}

function toTuiTaskSummary(task: TaskEntry): TuiTaskSummary {
  return {
    issue: task.issue,
    title: task.title,
    state: task.state,
    runtimePhase: task.runtime_phase,
    prNumber: task.pr.number,
    failureCode: task.failure?.code ?? null,
    failureMessage: task.failure?.message ?? null,
    updatedAt: updatedAt(task),
  };
}

function buildRunLogs(
  tasks: TaskEntry[],
  yes: boolean,
): Array<{ id: string; message: string; level: "info" | "warn" }> {
  const logs: Array<{ id: string; message: string; level: "info" | "warn" }> = [];
  for (const task of tasks) {
    if (task.state === "paused" && task.failure?.code === "need_input_pending") {
      logs.push({
        id: `need-input:${task.issue}`,
        level: yes ? "info" : "warn",
        message: yes
          ? `issue #${task.issue} is waiting for need_input; -y cannot answer without an active runner question payload`
          : `issue #${task.issue} is waiting for need_input; answer in TUI then run autokit resume`,
      });
    }
  }
  return logs;
}

function renderTaskTable(tasks: TaskEntry[]): string {
  const rows = ["ISSUE  STATE       RUNTIME_PHASE  PR    BRANCH                    UPDATED"];
  for (const task of tasks) {
    const pr = task.pr.number === null ? "-" : `#${task.pr.number}`;
    rows.push(
      `${String(task.issue).padEnd(6)} ${task.state.padEnd(11)} ${(task.runtime_phase ?? "-").padEnd(14)} ${pr.padEnd(5)} ${(task.branch ?? "-").padEnd(25)} ${updatedAt(task)}`,
    );
  }
  return `${rows.join("\n")}\n`;
}

function selectRetryTargets(tasks: TaskEntry[], range: string | undefined): TaskEntry[] {
  if (range === undefined) {
    return tasks.filter(
      (task) => task.state === "failed" || task.failure?.code === "retry_cleanup_failed",
    );
  }
  const parsed = parseIssueRange(range);
  if (parsed === "all") {
    return tasks.filter(
      (task) => task.state === "failed" || task.failure?.code === "retry_cleanup_failed",
    );
  }
  return tasks.filter((task) => parsed.includes(task.issue));
}

function replaceTaskAndWrite(tasksFile: TasksFile, task: TaskEntry, deps: CliDeps): void {
  const index = tasksFile.tasks.findIndex((entry) => entry.issue === task.issue);
  if (index < 0) {
    throw new Error(`issue #${task.issue} not found`);
  }
  tasksFile.tasks[index] = task;
  tasksFile.generated_at = now(deps);
  writeTasksFileAtomic(tasksPath(deps), tasksFile);
}

function isForceDetachCandidate(task: TaskEntry): boolean {
  return (
    task.state === "cleaning" ||
    (task.state === "paused" &&
      (task.failure?.code === "branch_delete_failed" ||
        task.failure?.code === "worktree_remove_failed"))
  );
}

function fetchIssue(deps: CliDeps, issue: number): IssueMetadata | null {
  if (deps.fetchIssue !== undefined) {
    return deps.fetchIssue(issue);
  }
  const raw = JSON.parse(
    exec(deps, "gh", ["issue", "view", String(issue), "--json", "number,title,state,labels"]),
  );
  return normalizeIssue(raw);
}

function fetchOpenIssues(deps: CliDeps): IssueMetadata[] {
  if (deps.fetchOpenIssues !== undefined) {
    return deps.fetchOpenIssues();
  }
  const raw = JSON.parse(
    exec(deps, "gh", ["issue", "list", "--state", "open", "--json", "number,title,state,labels"]),
  );
  return raw.map((issue: unknown) => normalizeIssue(issue));
}

function normalizeIssue(raw: unknown): IssueMetadata {
  const value = raw as {
    number: number;
    title: string;
    state: "OPEN" | "CLOSED";
    labels: Array<{ name: string }>;
  };
  return {
    number: value.number,
    title: value.title,
    state: value.state,
    labels: value.labels.map((label) => label.name),
  };
}

function exec(deps: CliDeps, command: string, args: string[]): string {
  const execFile = deps.execFile ?? defaultExecFile(deps);
  return execFile(command, args, { cwd: deps.cwd });
}

function defaultExecFile(deps: CliDeps): ExecFile {
  return (command, args, options) =>
    execFileSync(command, args, {
      cwd: options?.cwd ?? deps.cwd,
      env: buildGhEnv(deps.env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
}

function collectValues(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return Number(value);
}

function tasksPath(deps: CliDeps): string {
  return join(deps.cwd, ".autokit", "tasks.yaml");
}

function now(deps: CliDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function updatedAt(task: TaskEntry): string {
  return (
    task.timestamps.completed_at ??
    task.failure?.ts ??
    task.timestamps.started_at ??
    task.timestamps.added_at
  );
}

function isYes(deps: CliDeps, commandYes: boolean): boolean {
  return commandYes || deps.env.AUTOKIT_ASSUME_YES === "1";
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "issue" : slug;
}
