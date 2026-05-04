import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { render } from "ink-testing-library";
import { createElement } from "react";

import {
  App,
  createNeedInputAutoAnswer,
  formatLogTail,
  formatProgressList,
  handleQuestionInterrupt,
  normalizeQuestionAnswer,
  promptQuestion,
  QuestionPrompt,
} from "./index.ts";

describe("tui render model", () => {
  it("renders progress rows, failure reason, and bounded log tail", () => {
    assert.match(
      formatProgressList([
        {
          issue: 16,
          title: "[AK-015] tui-question-monitoring",
          state: "paused",
          runtimePhase: "implement",
          prNumber: 56,
          failureCode: "need_input_pending",
          failureMessage: "Pick test framework",
        },
      ]),
      /#16 paused implement PR #56 \[AK-015\].*need_input_pending: Pick test framework/,
    );

    assert.equal(
      formatLogTail(
        [
          { id: "1", level: "info", message: "first" },
          { id: "2", level: "warn", message: "second" },
        ],
        1,
      ),
      "WARN second",
    );
  });

  it("normalizes question answers and records -y auto-answer evidence", () => {
    const question = { text: "Use vitest?", defaultAnswer: "vitest", issue: 16 };

    assert.equal(normalizeQuestionAnswer("", question.defaultAnswer), "vitest");
    assert.equal(normalizeQuestionAnswer(" node:test ", question.defaultAnswer), "node:test");
    assert.deepEqual(
      createNeedInputAutoAnswer(question, () => "2026-05-05T09:00:00+09:00"),
      {
        answer: "vitest",
        logLine: {
          id: "2026-05-05T09:00:00+09:00:need-input-auto-answer",
          level: "info",
          ts: "2026-05-05T09:00:00+09:00",
          message: "auto-answered need_input with default for #16",
        },
      },
    );
  });

  it("maps Ctrl+C during need_input to tempfail interruption evidence", () => {
    assert.deepEqual(handleQuestionInterrupt({ text: "Use vitest?", defaultAnswer: "vitest" }), {
      exitCode: 75,
      failureCode: "interrupted",
      message: "interrupted while waiting for answer: Use vitest?",
    });
  });
});

describe("Ink components", () => {
  it("renders task progress, log tail, and question prompt", () => {
    const { lastFrame } = render(
      createElement(App, {
        tasks: [
          {
            issue: 16,
            title: "[AK-015] tui-question-monitoring",
            state: "implementing",
            runtimePhase: "implement",
          },
        ],
        logs: [{ id: "1", message: "runner started" }],
        question: { text: "Use vitest?", defaultAnswer: "vitest" },
      }),
    );

    assert.match(lastFrame() ?? "", /#16 implementing implement/);
    assert.match(lastFrame() ?? "", /INFO runner started/);
    assert.match(lastFrame() ?? "", /\? Use vitest\?/);
    assert.match(lastFrame() ?? "", /Default: vitest/);
  });

  it("emits -y auto-answer evidence", async () => {
    const autoAnswers: string[] = [];
    const autoLogs: string[] = [];
    render(
      createElement(QuestionPrompt, {
        question: { text: "Use vitest?", defaultAnswer: "vitest" },
        yes: true,
        onAnswer: (answer: string) => autoAnswers.push(answer),
        onAutoAnswer: (result) => autoLogs.push(result.logLine.message),
        onInterrupt: () => undefined,
      }),
    );
    await waitForInk();
    assert.deepEqual(autoAnswers, ["vitest"]);
    assert.deepEqual(autoLogs, ["auto-answered need_input with default"]);

    const promptAnswer = await promptQuestion(
      { text: "Use vitest?", defaultAnswer: "vitest" },
      { yes: true },
    );
    assert.equal(promptAnswer.answer, "vitest");
    assert.equal(promptAnswer.logLine.message, "auto-answered need_input with default");
  });
});

async function waitForInk(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
