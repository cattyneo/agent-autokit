import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type AutokitConfig,
  buildGhEnv,
  buildGhPrCloseArgs,
  buildGhPrViewArgs,
  buildGitBranchDeleteArgs,
  buildGitWorktreeRemoveArgs,
  capabilityPhases,
  capabilityProviders,
  createAutokitLogger,
  createTaskEntry,
  DEFAULT_CONFIG,
  type EffortLevel,
  effortLevels,
  forceSeizeRunLock,
  type GhPrView,
  loadTasksFile,
  makeFailure,
  type Phase,
  type PhaseOverride,
  type PromptContractQuestion,
  type Provider,
  parseConfigYaml,
  parseGhPrView,
  type RunLock,
  type RuntimePhase,
  retryCleanupTask,
  sanitizeLogString,
  serializeConfigYaml,
  type TaskEntry,
  type TasksFile,
  transitionTask,
  tryAcquireRunLock,
  validateCapabilitySelection,
  writeTasksFileAtomic,
} from "@cattyneo/autokit-core";
import {
  type AutokitServeOptions,
  type AutokitServeServer,
  type ServeRunStatus,
  type ServeWorkflowInput,
  startAutokitServe,
} from "@cattyneo/autokit-serve";
import {
  createNeedInputAutoAnswer,
  formatRunFrame,
  promptQuestion,
  type TuiTaskSummary,
} from "@cattyneo/autokit-tui";
import type { WorkflowRunner } from "@cattyneo/autokit-workflows";
import { Command, CommanderError } from "commander";
import { redactGitDiff } from "./diff.js";
import { runProductionWorkflow } from "./executor.js";
import { type InitOptions, promptContractAssetNames, runInit } from "./init.js";
import {
  commandPresetApply,
  commandPresetList,
  commandPresetShow,
  type PresetCliDeps,
} from "./preset.js";

export const AUTOKIT_VERSION = "0.1.0";
export const TEMPFAIL_EXIT_CODE = 75;

export type CliWriter = { write(chunk: string): void };

export type ExecFile = (command: string, args: string[], options?: { cwd?: string }) => string;
export type ForceUnlockConfirmInput = {
  isTTY?: boolean;
  readLineSync: () => string;
};

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
  runWorkflow?: (input: RunWorkflowInput) => Promise<TaskEntry[]> | TaskEntry[];
  workflowRunner?: WorkflowRunner;
  workflowMaxSteps?: number;
  askQuestion?: (input: CliQuestionInput) => Promise<string> | string;
  initProject?: (input: InitOptions) => { changed: string[]; skipped: string[]; dryRun: boolean };
  startServe?: (
    input: AutokitServeOptions,
  ) => Promise<Pick<AutokitServeServer, "host" | "port" | "tokenPath" | "close">>;
  proc?: Pick<NodeJS.Process, "once" | "exit">;
  presetAssetRoot?: string;
  presetPostApplyCheck?: (input: { repoRoot: string; presetName: string }) => void;
  forceUnlock?: boolean;
};

export type CliQuestionInput = {
  task: TaskEntry;
  phase: RuntimePhase;
  question: PromptContractQuestion;
  turn: number;
};

export type PhaseOverrideInput = Omit<PhaseOverride, "expires_at_run_id">;

type RunWorkflowInput = {
  yes: boolean;
  issue?: number;
  phaseOverride?: PhaseOverrideInput;
  answerQuestion: (input: CliQuestionInput) => Promise<string> | string;
};

export function getAutokitVersion(): string {
  return AUTOKIT_VERSION;
}

export function createForceUnlockConfirm(input: ForceUnlockConfirmInput, stderr: CliWriter) {
  return (message: string): boolean => {
    if (input.isTTY !== true) {
      stderr.write("force-unlock requires an interactive terminal\n");
      return false;
    }
    stderr.write(
      `${message}\nConfirm the owner process has been killed or is unreachable, then type force-unlock: `,
    );
    return input.readLineSync().trim() === "force-unlock";
  };
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let exitCode = 0;
  const runtimeDeps: CliDeps = {
    ...deps,
    forceUnlock: deps.forceUnlock ?? argv.includes("--force-unlock"),
  };
  const program = createProgram(runtimeDeps, (code) => {
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
    .command("init")
    .description("initialize autokit assets in this repository")
    .option("--dry-run", "show planned changes without writing")
    .option("--force", "allow init when prior backup residue exists")
    .action((options: { dryRun?: boolean; force?: boolean }) => {
      setExitCode(commandInit(options, deps));
    });

  const preset = program.command("preset").description("list, show, and apply autokit presets");

  preset
    .command("list")
    .description("list bundled and repository-local presets")
    .action(() => {
      setExitCode(commandPresetList(toPresetDeps(deps)));
    });

  preset
    .command("show")
    .description("show sanitized preset contents")
    .argument("<name>", "preset name")
    .action((name: string) => {
      setExitCode(commandPresetShow(name, toPresetDeps(deps)));
    });

  preset
    .command("apply")
    .description("apply a preset to .agents and .autokit/config.yaml")
    .argument("<name>", "preset name")
    .option("--allow-protected-replace", "allow protected array replacement")
    .action((name: string, options: { allowProtectedReplace?: boolean }) => {
      setExitCode(
        withWriteCommandLock(deps, () =>
          commandPresetApply(name, options, toPresetDeps(deps, { withPostApplyCheck: true })),
        ),
      );
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
    .command("serve")
    .description("start the local autokit HTTP API server")
    .option("--host <host>", "bind host", "127.0.0.1")
    .option("--port <port>", "bind port", "0")
    .action(async (options: { host: string; port: string }) => {
      setExitCode(
        await commandServe(options, deps, program.opts<{ yes?: boolean }>().yes === true),
      );
    });

  program
    .command("logs")
    .description("show sanitized autokit logs for one issue")
    .requiredOption("--issue <issue>", "issue number")
    .action((options: { issue: string }) => {
      setExitCode(commandLogs(options, deps));
    });

  program
    .command("diff")
    .description("show sanitized working tree diff for one issue")
    .requiredOption("--issue <issue>", "issue number")
    .action((options: { issue: string }) => {
      setExitCode(commandDiff(options, deps));
    });

  const config = program.command("config").description("inspect autokit configuration");
  config
    .command("show")
    .description("show effective autokit configuration")
    .option("--matrix", "show phase/provider/effort permission matrix")
    .action((options: { matrix?: boolean }) => {
      setExitCode(commandConfigShow(options, deps));
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
    .option("--phase <phase>", "limit provider/effort override to one agent phase")
    .option("--provider <provider>", "override provider for one run")
    .option("--effort <effort>", "override effort for one run")
    .action(async (options: RawPhaseOverrideOptions) => {
      const phaseOverride = parsePhaseOverrideOptions(options, deps);
      if (phaseOverride === "invalid") {
        setExitCode(2);
        return;
      }
      setExitCode(
        await withWriteCommandLockAsync(deps, () =>
          commandWorkflowStatus(deps, program.opts<{ yes?: boolean }>().yes === true, {
            phaseOverride,
          }),
        ),
      );
    });

  program
    .command("resume")
    .description("dispatch resume entrypoint without workflow internals")
    .argument("[issue]", "issue number")
    .action(async (issue?: string) => {
      setExitCode(await commandResume(issue, deps));
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

function toPresetDeps(
  deps: CliDeps,
  options: { withPostApplyCheck?: boolean } = {},
): PresetCliDeps {
  return {
    cwd: deps.cwd,
    env: deps.env,
    stdout: deps.stdout,
    stderr: deps.stderr,
    now: deps.now,
    presetAssetRoot: deps.presetAssetRoot,
    presetPostApplyCheck:
      options.withPostApplyCheck === true
        ? (deps.presetPostApplyCheck ??
          (() => {
            const result = runDoctor(deps);
            const failures = result.checks.filter((check) => check.status === "FAIL");
            if (failures.length > 0) {
              throw new Error(
                `doctor failed: ${failures
                  .map((check) => `${check.name}=${check.message}`)
                  .join("; ")}`,
              );
            }
          }))
        : undefined,
  };
}

function commandInit(options: { dryRun?: boolean; force?: boolean }, deps: CliDeps): number {
  return withWriteCommandLock(
    deps,
    () => commandInitLocked(options, deps),
    options.dryRun === true,
  );
}

function commandInitLocked(options: { dryRun?: boolean; force?: boolean }, deps: CliDeps): number {
  try {
    if (deps.initProject === undefined) {
      for (const check of [
        checkCommand(deps, "git repo", "git", ["rev-parse", "--is-inside-work-tree"]),
        checkCommand(deps, "gh auth", "gh", ["auth", "status"]),
        checkEnvUnset(deps),
      ]) {
        if (check.status === "FAIL") {
          deps.stderr.write(`${check.name}: ${check.message}\n`);
          return 1;
        }
      }
    }
    const result =
      deps.initProject?.({ dryRun: options.dryRun === true, force: options.force === true }) ??
      runInit(deps.cwd, { dryRun: options.dryRun === true, force: options.force === true });
    deps.stdout.write(result.dryRun ? "init dry-run\n" : "init complete\n");
    for (const entry of result.changed) {
      deps.stdout.write(`change\t${entry}\n`);
    }
    for (const entry of result.skipped) {
      deps.stdout.write(`skip\t${entry}\n`);
    }
    return 0;
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function commandServe(
  options: { host: string; port: string },
  deps: CliDeps,
  yes: boolean,
): Promise<number> {
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    deps.stderr.write("invalid port\n");
    return 2;
  }
  try {
    const starter = deps.startServe ?? startAutokitServe;
    const server = await starter({
      repoRoot: deps.cwd,
      env: deps.env,
      host: options.host,
      port,
      now: deps.now,
      runWorkflow: (input) => runServeWorkflow(input, deps, yes),
    });
    installServeSignalCleanup(server, deps.proc);
    deps.stdout.write(`serve listening\thttp://${server.host}:${server.port}\n`);
    deps.stdout.write(`token file\t${server.tokenPath}\n`);
    return 0;
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runServeWorkflow(
  input: ServeWorkflowInput,
  deps: CliDeps,
  yes: boolean,
): Promise<{
  status: Exclude<ServeRunStatus, "accepted" | "running" | "resume_required">;
  cleaned?: number;
}> {
  if (input.operation === "resume") {
    const code = await commandResumeLocked(input.issue, deps, yes);
    return { status: serveStatusFromExitCode(code) };
  }
  if (input.operation === "retry") {
    const code = commandRetryLocked(
      input.issue === undefined ? undefined : String(input.issue),
      {},
      deps,
    );
    return { status: serveStatusFromExitCode(code) };
  }
  if (input.operation === "cleanup") {
    if (input.issue === undefined) {
      throw new Error("cleanup requires issue");
    }
    const code = commandCleanupLocked(
      input.issue,
      { forceDetach: String(input.issue), dryRun: false },
      { ...deps, confirm: () => true },
    );
    return { status: serveStatusFromExitCode(code), cleaned: code === 0 ? 1 : 0 };
  }
  const tasks = await runProductionWorkflow({
    cwd: deps.cwd,
    env: deps.env,
    issue: input.issue,
    execFile: deps.execFile,
    runner: deps.workflowRunner,
    maxSteps: deps.workflowMaxSteps,
    now: deps.now,
    auditOperation: input.auditOperation,
    workflowEvent: (event) => {
      if (event.kind === "phase_started") {
        input.emitEvent?.({
          kind: "phase_started",
          data: {
            issue: event.issue,
            phase: event.phase,
            provider: event.provider,
            effort: event.effort,
            at: event.at,
          },
        });
        return;
      }
      input.emitEvent?.({
        kind: "runner_stdout",
        data: {
          issue: event.issue,
          phase: event.phase,
          chunk: event.chunk,
          at: event.at,
        },
      });
    },
    phaseOverride:
      input.phase === undefined
        ? undefined
        : { phase: input.phase, provider: input.provider, effort: input.effort },
    answerQuestion: (question) => answerCliQuestion(question, deps, yes),
  });
  return { status: workflowStatusForServe(tasks) };
}

function serveStatusFromExitCode(
  code: number,
): Exclude<ServeRunStatus, "accepted" | "running" | "resume_required"> {
  if (code === 0) {
    return "completed";
  }
  if (code === TEMPFAIL_EXIT_CODE) {
    return "paused";
  }
  return "failed";
}

function workflowStatusForServe(
  tasks: TaskEntry[],
): Exclude<ServeRunStatus, "accepted" | "running" | "resume_required"> {
  if (tasks.some((task) => task.state === "failed")) {
    return "failed";
  }
  if (tasks.some((task) => task.state === "paused" || task.state === "cleaning")) {
    return "paused";
  }
  return tasks.every((task) => task.state === "merged") ? "completed" : "interrupted";
}

function installServeSignalCleanup(
  server: Pick<AutokitServeServer, "close">,
  proc: Pick<NodeJS.Process, "once" | "exit"> = process,
): void {
  const closeAndExit = () => {
    void server.close().finally(() => proc.exit(0));
  };
  proc.once("SIGINT", closeAndExit);
  proc.once("SIGTERM", closeAndExit);
}

function withWriteCommandLock(deps: CliDeps, action: () => number, skip = false): number {
  if (skip) {
    return action();
  }
  const config = loadConfigForLock(deps);
  let lock = tryAcquireRunLock(deps.cwd, { config });
  if (!lock.acquired) {
    if (lock.reason === "host_mismatch") {
      const seized = maybeForceSeizeLock(deps, config, lock.holder);
      if (!seized.acquired) {
        return seized.exitCode;
      }
      lock = seized;
    } else {
      deps.stderr.write("autokit lock busy; another autokit command or serve process is active\n");
      return TEMPFAIL_EXIT_CODE;
    }
  }
  let result = 1;
  try {
    result = action();
  } finally {
    if (!lock.lock.release()) {
      deps.stderr.write(
        "autokit lock release failed; inspect .autokit/.lock for unexpected files before manual removal\n",
      );
      result = result === 0 ? 1 : result;
    }
  }
  return result;
}

async function withWriteCommandLockAsync(
  deps: CliDeps,
  action: () => Promise<number>,
): Promise<number> {
  const config = loadConfigForLock(deps);
  let lock = tryAcquireRunLock(deps.cwd, { config });
  if (!lock.acquired) {
    if (lock.reason === "host_mismatch") {
      const seized = maybeForceSeizeLock(deps, config, lock.holder);
      if (!seized.acquired) {
        return seized.exitCode;
      }
      lock = seized;
    } else {
      deps.stderr.write("autokit lock busy; another autokit command or serve process is active\n");
      return TEMPFAIL_EXIT_CODE;
    }
  }
  let result = 1;
  try {
    result = await action();
  } finally {
    if (!lock.lock.release()) {
      deps.stderr.write(
        "autokit lock release failed; inspect .autokit/.lock for unexpected files before manual removal\n",
      );
      result = result === 0 ? 1 : result;
    }
  }
  return result;
}

function maybeForceSeizeLock(
  deps: CliDeps,
  config: AutokitConfig,
  holder: { pid: number; host: string; started_at_lstart: string; run_id?: string } | null,
): { acquired: true; lock: RunLock } | { acquired: false; exitCode: number } {
  if (deps.forceUnlock !== true) {
    auditLockHostMismatch(deps, config, holder);
    deps.stderr.write("lock_host_mismatch: autokit lock is held by another host\n");
    return { acquired: false, exitCode: 1 };
  }
  if (deps.confirm?.("force-unlock lock held by another host?") !== true) {
    auditLockHostMismatch(deps, config, holder);
    deps.stderr.write("lock_host_mismatch: force-unlock confirmation required\n");
    return { acquired: false, exitCode: 1 };
  }
  const seized = forceSeizeRunLock(deps.cwd, { config });
  if (!seized.seized) {
    auditLockHostMismatch(deps, config, seized.holder ?? holder);
    deps.stderr.write(`lock_host_mismatch: force-unlock failed (${seized.reason})\n`);
    return { acquired: false, exitCode: 1 };
  }
  const logger = createCliLogger(deps, config);
  logger.auditOperation("lock_seized", {
    prior: seized.prior,
    seizing: {
      pid: seized.lock.holder.pid,
      host: seized.lock.holder.host,
      started_at_lstart: seized.lock.holder.started_at_lstart,
      command: "autokit --force-unlock",
    },
  });
  logger.close();
  deps.stderr.write("lock_seized: force-unlock acquired autokit lock\n");
  return { acquired: true, lock: seized.lock };
}

function auditLockHostMismatch(
  deps: CliDeps,
  config: AutokitConfig,
  holder: { pid: number; host: string; started_at_lstart: string; run_id?: string } | null,
): void {
  const logger = createCliLogger(deps, config);
  logger.auditFailure({
    failure: {
      phase: "lock",
      code: "lock_host_mismatch",
      message: "autokit lock is held by another host",
      ts: deps.now?.() ?? new Date().toISOString(),
    },
    payload: { holder },
  });
  logger.close();
}

function createCliLogger(deps: CliDeps, config: AutokitConfig) {
  const now = deps.now;
  return createAutokitLogger({
    logDir: join(deps.cwd, ".autokit", "logs"),
    config,
    now: now === undefined ? undefined : () => new Date(now()),
  });
}

function loadConfigForLock(deps: CliDeps): AutokitConfig {
  try {
    return loadConfigForCli(deps);
  } catch {
    return {
      ...DEFAULT_CONFIG,
      serve: {
        ...DEFAULT_CONFIG.serve,
        lock: {
          ...DEFAULT_CONFIG.serve.lock,
          host_redact: true,
        },
      },
    };
  }
}

function commandAdd(
  range: string,
  options: { label: string[]; force?: boolean; dryRun?: boolean; yes?: boolean },
  deps: CliDeps,
): number {
  let parsedRange: number[] | "all";
  try {
    parsedRange = parseIssueRange(range);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  return withWriteCommandLock(
    deps,
    () => commandAddLocked(parsedRange, options, deps),
    options.dryRun === true,
  );
}

function commandAddLocked(
  parsedRange: number[] | "all",
  options: { label: string[]; force?: boolean; dryRun?: boolean; yes?: boolean },
  deps: CliDeps,
): number {
  const targets =
    parsedRange === "all"
      ? fetchOpenIssues(deps)
      : parsedRange.map((issue) => fetchIssue(deps, issue)).filter((issue) => issue !== null);

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

async function commandWorkflowStatus(
  deps: CliDeps,
  yes = false,
  options: { phaseOverride?: PhaseOverrideInput; targetIssue?: number } = {},
): Promise<number> {
  try {
    const runWorkflow =
      deps.runWorkflow ??
      ((input: RunWorkflowInput) =>
        runProductionWorkflow({
          cwd: deps.cwd,
          env: deps.env,
          execFile: deps.execFile,
          runner: deps.workflowRunner,
          maxSteps: deps.workflowMaxSteps,
          now: deps.now,
          issue: input.issue,
          phaseOverride: input.phaseOverride,
          answerQuestion: input.answerQuestion,
        }));
    const tasks = await runWorkflow({
      yes,
      issue: options.targetIssue,
      phaseOverride: options.phaseOverride,
      answerQuestion: (input) => answerCliQuestion(input, deps, yes),
    });
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

async function commandResume(issue: string | undefined, deps: CliDeps): Promise<number> {
  let targetIssue: number | undefined;
  try {
    targetIssue = issue === undefined ? undefined : parsePositiveInteger(issue);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  return withWriteCommandLockAsync(deps, () => commandResumeLocked(targetIssue, deps));
}

async function commandResumeLocked(
  targetIssue: number | undefined,
  deps: CliDeps,
  yes = false,
): Promise<number> {
  const tasksFile = loadTasksOrEmpty(deps);
  const tasks = tasksFile.tasks;
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
  if (target === undefined) {
    return getWorkflowExitCode(tasks);
  }

  const index = tasks.findIndex((task) => task.issue === target.issue);
  tasksFile.tasks[index] = transitionTask(target, { type: "resume" });
  tasksFile.generated_at = now(deps);
  writeTasksFileAtomic(tasksPath(deps), tasksFile);
  return commandWorkflowStatus(deps, yes, { targetIssue: target.issue });
}

function commandRetry(
  range: string | undefined,
  options: { recoverCorruption?: string },
  deps: CliDeps,
): number {
  return withWriteCommandLock(deps, () => commandRetryLocked(range, options, deps));
}

function commandRetryLocked(
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

  return withWriteCommandLock(
    deps,
    () => commandCleanupLocked(issue, options, deps),
    options.dryRun === true,
  );
}

function commandCleanupLocked(
  issue: number,
  options: { forceDetach: string; dryRun?: boolean },
  deps: CliDeps,
): number {
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

function commandLogs(options: { issue: string }, deps: CliDeps): number {
  let issue: number;
  try {
    issue = parsePositiveInteger(options.issue);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    const config = loadConfigForCli(deps);
    const lines = readSanitizedIssueLogLines(deps, issue, config);
    deps.stdout.write(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
    return 0;
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function commandDiff(options: { issue: string }, deps: CliDeps): number {
  try {
    parsePositiveInteger(options.issue);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    const config = loadConfigForCli(deps);
    const rawDiff = exec(deps, "git", ["diff", "--no-ext-diff", "HEAD", "--"]);
    deps.stdout.write(redactGitDiff(rawDiff, config, redactionPaths(deps)));
    return 0;
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
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
  checks.push(checkAutokitGitignore(deps));
  checks.push(checkAutokitLockModes(deps));
  checks.push(checkConfig(deps));
  checks.push(checkStalePhaseOverride(deps));
  checks.push(checkPromptContracts(deps));
  return { ok: checks.every((check) => check.status !== "FAIL"), checks };
}

type RawPhaseOverrideOptions = {
  phase?: string;
  provider?: string;
  effort?: string;
};

function parsePhaseOverrideOptions(
  options: RawPhaseOverrideOptions,
  deps: CliDeps,
): PhaseOverrideInput | undefined | "invalid" {
  try {
    return validatePhaseOverride(options);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return "invalid";
  }
}

export function validatePhaseOverride(
  options: RawPhaseOverrideOptions,
): PhaseOverrideInput | undefined {
  if (
    options.phase === undefined &&
    (options.provider !== undefined || options.effort !== undefined)
  ) {
    throw new Error("--provider and --effort require --phase");
  }
  if (options.phase === undefined) {
    return undefined;
  }
  if (options.provider === undefined && options.effort === undefined) {
    throw new Error("--phase requires --provider or --effort");
  }
  if (!(capabilityPhases as readonly string[]).includes(options.phase)) {
    throw new Error(`unsupported override phase: ${options.phase}`);
  }
  const phase = options.phase as Phase;
  let provider: Provider | undefined;
  if (options.provider !== undefined) {
    provider = parseOverrideProvider(options.provider);
    validateCapabilitySelection({ phase, provider });
  }
  const effort = options.effort === undefined ? undefined : parseOverrideEffort(options.effort);
  return { phase, provider, effort };
}

function parseOverrideProvider(value: string): Provider {
  if (!(capabilityProviders as readonly string[]).includes(value)) {
    throw new Error(`unsupported override provider: ${value}`);
  }
  return value as Provider;
}

function parseOverrideEffort(value: string): EffortLevel {
  if (!(effortLevels as readonly string[]).includes(value)) {
    throw new Error(`unsupported override effort: ${value}`);
  }
  return value as EffortLevel;
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
  const leaked = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"].filter(
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
        existsSync(path) &&
        /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY)=/m.test(readFileSync(path, "utf8"))
      );
    },
  );
  return leakedFiles.length === 0
    ? { name: "cwd .env", status: "PASS", message: "no API keys found" }
    : { name: "cwd .env", status: "FAIL", message: `${leakedFiles.join(",")} contains API keys` };
}

function checkAutokitGitignore(deps: CliDeps): DoctorCheck {
  const path = join(deps.cwd, ".autokit", ".gitignore");
  if (!existsSync(path)) {
    return {
      name: ".autokit gitignore",
      status: "FAIL",
      message: ".autokit/.gitignore missing",
    };
  }
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const required = ["*", "!.gitignore", "!config.yaml"];
  const missing = required.filter((line) => !lines.includes(line));
  if (missing.length > 0) {
    return {
      name: ".autokit gitignore",
      status: "FAIL",
      message: `must contain ${missing.join(",")}`,
    };
  }
  const extra = lines.filter((line) => !required.includes(line));
  if (extra.length > 0) {
    return {
      name: ".autokit gitignore",
      status: "FAIL",
      message: `must not contain extra rules ${extra.join(",")}`,
    };
  }
  return { name: ".autokit gitignore", status: "PASS", message: "protected" };
}

function checkAutokitLockModes(deps: CliDeps): DoctorCheck {
  const lockDir = join(deps.cwd, ".autokit", ".lock");
  if (!existsSync(lockDir)) {
    return { name: ".autokit lock mode", status: "PASS", message: "absent" };
  }
  try {
    const lockStat = lstatSync(lockDir);
    if (!lockStat.isDirectory()) {
      return {
        name: ".autokit lock mode",
        status: "FAIL",
        message: ".autokit/.lock must be a directory",
      };
    }
    if ((lockStat.mode & 0o777) !== 0o700) {
      return {
        name: ".autokit lock mode",
        status: "FAIL",
        message: ".autokit/.lock must be mode 0700",
      };
    }
    const holderPath = join(lockDir, "holder.json");
    if (!existsSync(holderPath)) {
      return { name: ".autokit lock mode", status: "PASS", message: "directory protected" };
    }
    const holderStat = lstatSync(holderPath);
    if (!holderStat.isFile()) {
      return {
        name: ".autokit lock mode",
        status: "FAIL",
        message: ".autokit/.lock/holder.json must be a file",
      };
    }
    if ((holderStat.mode & 0o777) !== 0o600) {
      return {
        name: ".autokit lock mode",
        status: "FAIL",
        message: ".autokit/.lock/holder.json must be mode 0600",
      };
    }
    return { name: ".autokit lock mode", status: "PASS", message: "protected" };
  } catch (error) {
    return {
      name: ".autokit lock mode",
      status: "FAIL",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkConfig(deps: CliDeps): DoctorCheck {
  const path = join(deps.cwd, ".autokit", "config.yaml");
  if (!existsSync(path)) {
    return { name: "config", status: "WARN", message: ".autokit/config.yaml not found" };
  }
  try {
    const source = readFileSync(path, "utf8");
    parseConfigYaml(source);
    if (/^\s*allowed_tools\s*:/m.test(source)) {
      return {
        name: "config",
        status: "WARN",
        message:
          "permissions.claude.allowed_tools is deprecated; capability table hard cap applies",
      };
    }
    return { name: "config", status: "PASS", message: "valid" };
  } catch (error) {
    return {
      name: "config",
      status: "FAIL",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkStalePhaseOverride(deps: CliDeps): DoctorCheck {
  const path = tasksPath(deps);
  if (!existsSync(path)) {
    return { name: "phase override", status: "PASS", message: "none" };
  }
  try {
    const tasks = loadTasksFile(path).tasks;
    const stale = tasks.find((task) => task.runtime.phase_override !== null);
    if (stale === undefined) {
      return { name: "phase override", status: "PASS", message: "none" };
    }
    return {
      name: "phase override",
      status: "FAIL",
      message: `stale phase_override for #${stale.issue}`,
    };
  } catch (error) {
    return {
      name: "phase override",
      status: "FAIL",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function commandConfigShow(options: { matrix?: boolean }, deps: CliDeps): number {
  try {
    const config = loadConfigForCli(deps);
    deps.stdout.write(
      options.matrix === true ? renderConfigMatrix(config) : serializeConfigYaml(config),
    );
    return 0;
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function readSanitizedIssueLogLines(deps: CliDeps, issue: number, config: AutokitConfig): string[] {
  const logsDir = join(deps.cwd, ".autokit", "logs");
  if (!existsSync(logsDir)) {
    return [];
  }
  return listLogFiles(logsDir).flatMap((file) =>
    readFileSync(file.path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => renderSanitizedLogLine(line, issue, config, deps)),
  );
}

function listLogFiles(logsDir: string): Array<{ path: string; mtimeMs: number }> {
  return readdirSync(logsDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}(?:-\d+)?\.log$/.test(name))
    .map((name) => {
      const path = join(logsDir, name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
}

function renderSanitizedLogLine(
  line: string,
  issue: number,
  config: AutokitConfig,
  deps: CliDeps,
): string[] {
  try {
    const parsed = JSON.parse(line) as { issue?: unknown };
    if (parsed.issue !== issue) {
      return [];
    }
    return [JSON.stringify(sanitizeLogValue(parsed, config, deps))];
  } catch {
    return [];
  }
}

function redactionPaths(deps: CliDeps) {
  return { homeDir: deps.env.HOME, repoRoot: deps.cwd };
}

function sanitizeLogValue(
  value: unknown,
  config: AutokitConfig,
  deps: CliDeps,
  key?: string,
): unknown {
  if (typeof value === "string") {
    if (key !== undefined && isSensitiveLogFieldKey(key)) {
      return "<REDACTED>";
    }
    return sanitizeLogString(value, config, false, redactionPaths(deps));
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, config, deps, key));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, item]) => [
        entryKey,
        sanitizeLogValue(item, config, deps, entryKey),
      ]),
    );
  }
  return value;
}

function isSensitiveLogFieldKey(key: string): boolean {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized.includes("privatekey") ||
    normalized.includes("apikey")
  );
}

function loadConfigForCli(deps: CliDeps) {
  const path = join(deps.cwd, ".autokit", "config.yaml");
  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }
  return parseConfigYaml(readFileSync(path, "utf8"));
}

function renderConfigMatrix(config = DEFAULT_CONFIG): string {
  const rows = ["phase\tprovider\teffort\tprompt_contract\tpermission_profile"];
  for (const phase of capabilityPhases) {
    const provider = config.phases[phase].provider;
    const row = validateCapabilitySelection({ phase, provider });
    rows.push(
      [
        phase,
        provider,
        config.phases[phase].effort ?? config.effort.default,
        config.phases[phase].prompt_contract,
        row.permission_profile,
      ].join("\t"),
    );
  }
  return `${rows.join("\n")}\n`;
}

function checkPromptContracts(deps: CliDeps): DoctorCheck {
  const promptsDir = join(deps.cwd, ".agents", "prompts");
  if (!existsSync(promptsDir)) {
    return { name: "prompt contracts", status: "WARN", message: ".agents/prompts not found" };
  }
  const expected: string[] = Object.values(DEFAULT_CONFIG.phases)
    .map((phase) => phase.prompt_contract)
    .sort();
  const actual = promptContractAssetNames(join(deps.cwd, ".agents"));
  const missing = expected.filter((contract) => !actual.includes(contract));
  const extra = actual.filter((contract) => !expected.includes(contract));
  if (missing.length > 0 || extra.length > 0) {
    return {
      name: "prompt contracts",
      status: "FAIL",
      message: `missing=${missing.join(",") || "-"} extra=${extra.join(",") || "-"}`,
    };
  }
  return { name: "prompt contracts", status: "PASS", message: "valid" };
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
