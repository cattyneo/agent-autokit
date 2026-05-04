export const CORE_PACKAGE = "@cattyneo/autokit-core";

export type {
  AutokitConfig,
  PhaseConfig,
  PromptContractId,
  Provider,
  RuntimePhase,
} from "./config.js";
export {
  ConfigParseError,
  DEFAULT_CONFIG,
  parseConfig,
  parseConfigYaml,
  phasePromptContracts,
  runtimePhases,
} from "./config.js";
export type { ChildEnv, ParentEnv, RunnerEnvOptions } from "./env-allowlist.js";
export { buildGhEnv, buildRunnerEnv } from "./env-allowlist.js";
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
