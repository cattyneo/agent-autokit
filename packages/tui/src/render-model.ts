export type TuiTaskSummary = {
  issue: number;
  title: string;
  state: string;
  runtimePhase?: string | null;
  prNumber?: number | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  updatedAt?: string | null;
};

export type TuiLogLine = {
  id: string;
  message: string;
  level?: "debug" | "info" | "warn" | "error";
  ts?: string | null;
};

export type TuiQuestion = {
  text: string;
  defaultAnswer: string;
  issue?: number | null;
  phase?: string | null;
};

export type NeedInputAutoAnswer = {
  answer: string;
  logLine: TuiLogLine;
};

export const TEMPFAIL_EXIT_CODE = 75;

export function formatProgressList(tasks: TuiTaskSummary[]): string {
  if (tasks.length === 0) {
    return "No tasks";
  }
  return tasks
    .map((task) => {
      const issue = `#${task.issue}`;
      const phase =
        task.runtimePhase === null || task.runtimePhase === undefined ? "-" : task.runtimePhase;
      const pr = task.prNumber === null || task.prNumber === undefined ? "-" : `#${task.prNumber}`;
      const failure =
        task.failureCode === null || task.failureCode === undefined
          ? ""
          : ` ${task.failureCode}${task.failureMessage ? `: ${task.failureMessage}` : ""}`;
      return `${issue} ${task.state} ${phase} PR ${pr} ${task.title}${failure}`;
    })
    .join("\n");
}

export function formatLogTail(logs: TuiLogLine[], limit = 8): string {
  const tail = logs.slice(Math.max(0, logs.length - limit));
  if (tail.length === 0) {
    return "No logs";
  }
  return tail
    .map((line) => {
      const level = line.level ?? "info";
      const ts = line.ts === null || line.ts === undefined ? "" : `${line.ts} `;
      return `${ts}${level.toUpperCase()} ${line.message}`;
    })
    .join("\n");
}

export function formatQuestionPrompt(question: TuiQuestion): string {
  return `? ${question.text}\nDefault: ${question.defaultAnswer}`;
}

export function formatRunFrame(input: {
  tasks: TuiTaskSummary[];
  logs?: TuiLogLine[];
  question?: TuiQuestion | null;
  logLimit?: number;
}): string {
  const sections = [`Progress\n${formatProgressList(input.tasks)}`];
  sections.push(`Logs\n${formatLogTail(input.logs ?? [], input.logLimit)}`);
  if (input.question !== null && input.question !== undefined) {
    sections.push(formatQuestionPrompt(input.question));
  }
  return `${sections.join("\n\n")}\n`;
}

export function normalizeQuestionAnswer(input: string, defaultAnswer: string): string {
  const trimmed = input.trim();
  return trimmed.length === 0 ? defaultAnswer : trimmed;
}

export function createNeedInputAutoAnswer(
  question: TuiQuestion,
  now: () => string = () => new Date().toISOString(),
): NeedInputAutoAnswer {
  const ts = now();
  const target =
    question.issue === undefined || question.issue === null ? "" : ` for #${question.issue}`;
  return {
    answer: question.defaultAnswer,
    logLine: {
      id: `${ts}:need-input-auto-answer`,
      level: "info",
      ts,
      message: `auto-answered need_input with default${target}`,
    },
  };
}

export function handleQuestionInterrupt(question: TuiQuestion): {
  exitCode: typeof TEMPFAIL_EXIT_CODE;
  failureCode: "interrupted";
  message: string;
} {
  return {
    exitCode: TEMPFAIL_EXIT_CODE,
    failureCode: "interrupted",
    message: `interrupted while waiting for answer: ${question.text}`,
  };
}
