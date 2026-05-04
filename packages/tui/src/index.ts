export type {
  AppProps,
  LogTailProps,
  ProgressListProps,
  PromptQuestionOptions,
  QuestionPromptProps,
} from "./ink-components.js";
export { App, LogTail, ProgressList, promptQuestion, QuestionPrompt } from "./ink-components.js";
export type {
  NeedInputAutoAnswer,
  TuiLogLine,
  TuiQuestion,
  TuiTaskSummary,
} from "./render-model.js";
export {
  createNeedInputAutoAnswer,
  formatLogTail,
  formatProgressList,
  formatQuestionPrompt,
  formatRunFrame,
  handleQuestionInterrupt,
  normalizeQuestionAnswer,
} from "./render-model.js";

export const TUI_PACKAGE = "@cattyneo/autokit-tui";
