export const CORE_PACKAGE = "@cattyneo/autokit-core";

export type {
  CapabilityRow,
  ClaudeHook,
  ClaudePermission,
  CodexPermission,
  PermissionProfile,
  Phase,
} from "./capability.js";
export {
  CapabilityValidationError,
  capabilities,
  capabilityPhases,
  capabilityProviders,
  derive_claude_perm,
  derive_codex_perm,
  isCapabilityPhase,
  isCapabilityProvider,
  validateCapabilitySelection,
} from "./capability.js";
export type {
  AutokitConfig,
  EffortLevel,
  PhaseConfig,
  PromptContractId,
  Provider,
  ResolvedEffort,
  RuntimePhase,
  UnsupportedEffortPolicy,
} from "./config.js";
export {
  ConfigParseError,
  DEFAULT_CONFIG,
  parseConfig,
  parseConfigYaml,
  phasePromptContracts,
  resolveRunnerTimeout,
  runtimePhases,
  serializeConfigYaml,
} from "./config.js";
export type {
  EffortDowngradeAuditCandidate,
  EffortResolutionInput,
  EffortResolutionResult,
  PhaseOverride,
} from "./effort-resolver.js";
export { effortLevels, resolveEffort } from "./effort-resolver.js";
export type { ChildEnv, ParentEnv, RunnerEnvOptions } from "./env-allowlist.js";
export { buildGhEnv, buildRunnerEnv } from "./env-allowlist.js";
export type { GhPrView, GhPrViewJson } from "./gh.js";
export {
  buildGhIssueViewBodyArgs,
  buildGhPrCloseArgs,
  buildGhPrCreateDraftArgs,
  buildGhPrListHeadArgs,
  buildGhPrReadyArgs,
  buildGhPrViewArgs,
  buildGhPrViewCiArgs,
  buildGhPrViewHeadArgs,
  buildGhPrViewMergeArgs,
  buildGhRunViewFailedLogArgs,
  parseGhMergeability,
  parseGhPrView,
} from "./gh.js";
export type { GitWorktreeRemoveOptions } from "./git.js";
export {
  buildGitAddAllArgs,
  buildGitBranchDeleteArgs,
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
} from "./git.js";
export type {
  AuditFailureInput,
  AuditKind,
  FailureAuditKind,
  FailureCode,
  FailureRecord,
  LogLevel,
  OperationalAuditKind,
  SanitizeViolationAuditPayload,
  StateAuditInput,
} from "./logger.js";
export {
  AutokitLogger,
  createAutokitLogger,
  createSanitizeViolationAuditPayload,
  failureAuditKinds,
  failureCodes,
  operationalAuditKinds,
} from "./logger.js";
export type { ModelResolver, ResolvedModels, ResolveModelsOptions } from "./model-resolver.js";
export {
  createEmptyResolvedModels,
  ModelResolutionError,
  resolveModelsForPlanning,
} from "./model-resolver.js";
export type { GuardedCommandDecision, PathAccess, PathSafetyDecision } from "./path-safety.js";
export {
  sanitizeCommandOutput,
  validateGuardedCommand,
  validatePathAccess,
} from "./path-safety.js";
export { buildAutoMergeArgs, buildDisableAutoMergeArgs, shouldPauseForHeadMismatch } from "./pr.js";
export type {
  PullRequestObservation,
  ReconcileAction,
  ReconcileObservation,
  ReconcileResult,
} from "./reconcile.js";
export { reconcileTask } from "./reconcile.js";
export type { RedactionPathContext } from "./redaction.js";
export { sanitizeLogString } from "./redaction.js";
export type { RetryCleanupDeps } from "./retry-cleanup.js";
export { retryCleanupTask } from "./retry-cleanup.js";
export type {
  AgentRunInput,
  AgentRunOutput,
  AgentRunStatus,
  EffectivePermission,
  PromptContractData,
  PromptContractQuestion,
  PromptContractValidationResult,
  ValidPromptContractPayload,
} from "./runner-contract.js";
export {
  formatQuestionResponsePrompt,
  parsePromptContractYaml,
  promptContractForPhase,
  promptContractJsonSchema,
  QUESTION_RESPONSE_STRING_LIMIT,
  validatePromptContractPayload,
} from "./runner-contract.js";
export type { TransitionEvent } from "./state-machine.js";
export { isActiveState, isAgentRuntimePhase, transitionTask } from "./state-machine.js";
export type {
  CreateTaskEntryInput,
  FixCheckpoint,
  FixOrigin,
  ImplementCheckpoint,
  LoadTasksFileOptions,
  PlanState,
  ProviderSession,
  RetryCleanupProgress,
  SimpleCheckpoint,
  TaskEntry,
  TaskRuntimePhase,
  TaskState,
  TasksFile,
} from "./tasks.js";
export {
  cloneTask,
  createTaskEntry,
  emptyProviderSession,
  loadTasksFile,
  makeFailure,
  TaskFileParseError,
  taskAgentPhases,
  taskRuntimePhases,
  taskStates,
  writeTasksFileAtomic,
} from "./tasks.js";
