import { Box, render, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useRef, useState } from "react";

import {
  createNeedInputAutoAnswer,
  handleQuestionInterrupt,
  type NeedInputAutoAnswer,
  normalizeQuestionAnswer,
  type TuiLogLine,
  type TuiQuestion,
  type TuiTaskSummary,
} from "./render-model.js";

export type ProgressListProps = {
  tasks: TuiTaskSummary[];
};

export function ProgressList({ tasks }: ProgressListProps) {
  if (tasks.length === 0) {
    return <Text dimColor>No tasks</Text>;
  }
  return (
    <Box flexDirection="column">
      {tasks.map((task) => (
        <Box key={task.issue} flexDirection="column">
          <Text>
            <Text color={stateColor(task.state)}>#{task.issue}</Text> {task.state}{" "}
            <Text dimColor>{task.runtimePhase ?? "-"}</Text>{" "}
            <Text dimColor>
              {task.prNumber === null || task.prNumber === undefined
                ? "PR -"
                : `PR #${task.prNumber}`}
            </Text>{" "}
            {task.title}
          </Text>
          {task.failureCode !== null && task.failureCode !== undefined ? (
            <Text color="red">
              {task.failureCode}
              {task.failureMessage ? `: ${task.failureMessage}` : ""}
            </Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

export type LogTailProps = {
  logs: TuiLogLine[];
  limit?: number;
};

export function LogTail({ logs, limit = 8 }: LogTailProps) {
  const tail = logs.slice(Math.max(0, logs.length - limit));
  if (tail.length === 0) {
    return <Text dimColor>No logs</Text>;
  }
  return (
    <Box flexDirection="column">
      {tail.map((line) => (
        <Text key={line.id} color={logColor(line.level)}>
          {line.ts ? `${line.ts} ` : ""}
          {(line.level ?? "info").toUpperCase()} {line.message}
        </Text>
      ))}
    </Box>
  );
}

export type QuestionPromptProps = {
  question: TuiQuestion;
  yes?: boolean;
  onAnswer: (answer: string) => void;
  onAutoAnswer?: (result: NeedInputAutoAnswer) => void;
  onInterrupt: (result: ReturnType<typeof handleQuestionInterrupt>) => void;
};

export function QuestionPrompt({
  question,
  yes = false,
  onAnswer,
  onAutoAnswer,
  onInterrupt,
}: QuestionPromptProps) {
  const { exit } = useApp();
  const [draft, setDraft] = useState("");
  const autoAnswered = useRef(false);
  const submitted = useRef(false);

  const submitAnswer = (answer: string) => {
    if (submitted.current) {
      return;
    }
    submitted.current = true;
    onAnswer(answer);
    exit();
  };

  useEffect(() => {
    if (yes && !autoAnswered.current) {
      autoAnswered.current = true;
      const result = createNeedInputAutoAnswer(question);
      onAutoAnswer?.(result);
      submitAnswer(result.answer);
    }
  });

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === "c") {
      onInterrupt(handleQuestionInterrupt(question));
      exit();
      return;
    }
    if (key.return) {
      submitAnswer(normalizeQuestionAnswer(draft, question.defaultAnswer));
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="yellow">? {question.text}</Text>
      <Text dimColor>Default: {question.defaultAnswer}</Text>
      <Box>
        <Text>Answer: </Text>
        {yes ? (
          <Text>{question.defaultAnswer}</Text>
        ) : (
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={(value) =>
              submitAnswer(normalizeQuestionAnswer(value, question.defaultAnswer))
            }
          />
        )}
      </Box>
      {!yes && draft.length === 0 ? <Text dimColor>(press Enter for default)</Text> : null}
    </Box>
  );
}

export type PromptQuestionOptions = {
  yes?: boolean;
};

export async function promptQuestion(
  question: TuiQuestion,
  options: PromptQuestionOptions = {},
): Promise<NeedInputAutoAnswer> {
  if (options.yes === true) {
    return createNeedInputAutoAnswer(question);
  }

  let result: NeedInputAutoAnswer | undefined;
  let interrupted: ReturnType<typeof handleQuestionInterrupt> | undefined;
  const instance = render(
    <QuestionPrompt
      question={question}
      onAnswer={(answer) => {
        result = {
          answer,
          logLine: {
            id: `${new Date().toISOString()}:need-input-answer`,
            level: "info",
            ts: new Date().toISOString(),
            message: "answered need_input prompt",
          },
        };
      }}
      onAutoAnswer={(autoAnswer) => {
        result = autoAnswer;
      }}
      onInterrupt={(interrupt) => {
        interrupted = interrupt;
      }}
    />,
  );
  await instance.waitUntilExit();
  if (interrupted !== undefined) {
    throw Object.assign(new Error(interrupted.message), { code: interrupted.failureCode });
  }
  if (result === undefined) {
    throw Object.assign(new Error("question prompt exited without answer"), {
      code: "need_input_pending",
    });
  }
  return result;
}

export type AppProps = {
  tasks: TuiTaskSummary[];
  logs?: TuiLogLine[];
  question?: TuiQuestion | null;
  yes?: boolean;
  onAnswer?: (answer: string) => void;
  onAutoAnswer?: (result: NeedInputAutoAnswer) => void;
  onInterrupt?: (result: ReturnType<typeof handleQuestionInterrupt>) => void;
};

export function App({
  tasks,
  logs = [],
  question = null,
  yes = false,
  onAnswer = () => undefined,
  onAutoAnswer = () => undefined,
  onInterrupt = () => undefined,
}: AppProps) {
  return (
    <Box flexDirection="column">
      <Text bold>autokit</Text>
      <ProgressList tasks={tasks} />
      <Box marginTop={1} flexDirection="column">
        <Text bold>logs</Text>
        <LogTail logs={logs} />
      </Box>
      {question ? (
        <Box marginTop={1}>
          <QuestionPrompt
            question={question}
            yes={yes}
            onAnswer={onAnswer}
            onAutoAnswer={onAutoAnswer}
            onInterrupt={onInterrupt}
          />
        </Box>
      ) : null}
    </Box>
  );
}

function stateColor(state: string): "cyan" | "green" | "red" | "yellow" {
  if (state === "merged") return "green";
  if (state === "failed") return "red";
  if (state === "paused" || state === "cleaning") return "yellow";
  return "cyan";
}

function logColor(level: TuiLogLine["level"]): "white" | "yellow" | "red" | "gray" {
  if (level === "warn") return "yellow";
  if (level === "error") return "red";
  if (level === "debug") return "gray";
  return "white";
}
