import { parseDocument, stringify } from "yaml";
import * as z from "zod";

import {
  capabilityPhases,
  capabilityProviders,
  type Provider,
  validateCapabilitySelection,
} from "./capability.js";
import { effortLevels, type ResolvedEffort, unsupportedEffortPolicies } from "./effort-resolver.js";

export const runtimePhases = capabilityPhases;

export type RuntimePhase = (typeof runtimePhases)[number];
export type { Provider } from "./capability.js";
export type PromptContractId =
  | "plan"
  | "plan-verify"
  | "plan-fix"
  | "implement"
  | "review"
  | "supervise"
  | "fix";

export const phasePromptContracts = {
  plan: "plan",
  plan_verify: "plan-verify",
  plan_fix: "plan-fix",
  implement: "implement",
  review: "review",
  supervise: "supervise",
  fix: "fix",
} as const satisfies Record<RuntimePhase, PromptContractId>;

const defaultPhaseProviders = {
  plan: "claude",
  plan_verify: "codex",
  plan_fix: "claude",
  implement: "codex",
  review: "claude",
  supervise: "claude",
  fix: "codex",
} as const satisfies Record<RuntimePhase, Provider>;

const defaultBackupBlacklist = [
  ".claude/credentials*",
  ".claude/state",
  ".claude/sessions",
  ".codex/auth*",
  ".codex/credentials*",
  ".autokit/audit-hmac-key",
];

const defaultRedactPatterns = ["ghp_[A-Za-z0-9]{20,}", "sk-[A-Za-z0-9]{20,}"];

const positiveInteger = z.int().positive();
const nonNegativeInteger = z.int().nonnegative();
const modelNameSchema = z.string().trim().min(1);
const providerSchema = z.enum(capabilityProviders);
const effortLevelSchema = z.enum(effortLevels);

const defaultRunnerTimeoutMs = {
  plan: 600_000,
  plan_verify: 600_000,
  plan_fix: 600_000,
  implement: 1_800_000,
  review: 600_000,
  supervise: 600_000,
  fix: 600_000,
} as const satisfies Record<RuntimePhase, number>;

function phaseSchema(phase: RuntimePhase) {
  return z
    .strictObject({
      provider: providerSchema.default(defaultPhaseProviders[phase]),
      model: modelNameSchema.default("auto"),
      effort: effortLevelSchema.optional(),
      prompt_contract: z.literal(phasePromptContracts[phase]).default(phasePromptContracts[phase]),
    })
    .prefault({});
}

const configSchema = z
  .strictObject({
    version: z.literal(1).default(1),
    parallel: positiveInteger.default(1),
    base_branch: z.string().default(""),
    branch_prefix: z.string().min(1).default("autokit/"),
    auto_merge: z.boolean().default(true),
    review: z
      .strictObject({
        max_rounds: nonNegativeInteger.default(3),
        warn_threshold: nonNegativeInteger.default(2),
      })
      .prefault({}),
    plan: z
      .strictObject({
        max_rounds: nonNegativeInteger.default(4),
      })
      .prefault({}),
    ci: z
      .strictObject({
        poll_interval_ms: positiveInteger.default(10_000),
        timeout_ms: positiveInteger.default(1_800_000),
        timeout_action: z.enum(["paused", "failed"]).default("paused"),
        fix_max_rounds: nonNegativeInteger.default(3),
      })
      .prefault({}),
    merge: z
      .strictObject({
        poll_interval_ms: positiveInteger.default(5_000),
        timeout_ms: positiveInteger.default(1_800_000),
        branch_delete_grace_ms: nonNegativeInteger.default(5_000),
        worktree_remove_retry_max: nonNegativeInteger.default(3),
      })
      .prefault({}),
    label_filter: z.array(z.string().min(1)).default([]),
    runtime: z
      .strictObject({
        max_untrusted_input_kb: positiveInteger.default(256),
      })
      .prefault({}),
    effort: z
      .strictObject({
        default: effortLevelSchema.default("medium"),
        unsupported_policy: z.enum(unsupportedEffortPolicies).default("fail"),
      })
      .prefault({}),
    phases: z
      .strictObject({
        plan: phaseSchema("plan"),
        plan_verify: phaseSchema("plan_verify"),
        plan_fix: phaseSchema("plan_fix"),
        implement: phaseSchema("implement"),
        review: phaseSchema("review"),
        supervise: phaseSchema("supervise"),
        fix: phaseSchema("fix"),
      })
      .prefault({}),
    permissions: z
      .strictObject({
        claude: z
          .strictObject({
            auto_mode: z.enum(["off", "required", "optional"]).default("optional"),
            workspace_scope: z.enum(["worktree", "repo"]).default("worktree"),
            allowed_tools: z.array(z.string().min(1)).default(["Read", "Grep", "Glob"]),
            home_isolation: z.enum(["shared", "isolated"]).default("shared"),
          })
          .prefault({}),
        codex: z
          .strictObject({
            sandbox_mode: z.enum(["workspace-write", "readonly"]).default("workspace-write"),
            approval_policy: z.enum(["on-request", "never", "always"]).default("on-request"),
            allow_network: z.boolean().default(false),
            home_isolation: z.enum(["shared", "isolated"]).default("shared"),
          })
          .prefault({}),
      })
      .prefault({}),
    runner_timeout: z
      .strictObject({
        plan_ms: positiveInteger.optional(),
        plan_verify_ms: positiveInteger.optional(),
        plan_fix_ms: positiveInteger.optional(),
        implement_ms: positiveInteger.optional(),
        review_ms: positiveInteger.optional(),
        supervise_ms: positiveInteger.optional(),
        fix_ms: positiveInteger.optional(),
        default_ms: positiveInteger.optional(),
        plan_idle_ms: positiveInteger.optional(),
        plan_verify_idle_ms: positiveInteger.optional(),
        plan_fix_idle_ms: positiveInteger.optional(),
        implement_idle_ms: positiveInteger.optional(),
        review_idle_ms: positiveInteger.optional(),
        supervise_idle_ms: positiveInteger.optional(),
        fix_idle_ms: positiveInteger.optional(),
        default_idle_ms: positiveInteger.optional(),
      })
      .prefault({}),
    logging: z
      .strictObject({
        level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        retention_days: positiveInteger.default(30),
        max_file_size_mb: positiveInteger.default(100),
        max_total_size_mb: positiveInteger.default(1_024),
        redact_patterns: z.array(z.string().min(1)).default(defaultRedactPatterns),
      })
      .prefault({}),
    init: z
      .strictObject({
        backup_dir: z.string().min(1).default(".autokit/.backup"),
        backup_mode: z
          .string()
          .regex(/^[0-7]{4}$/)
          .default("0700"),
        backup_blacklist: z.array(z.string().min(1)).default(defaultBackupBlacklist),
      })
      .prefault({}),
  })
  .superRefine((config, context) => {
    if (
      config.permissions.codex.allow_network &&
      config.permissions.codex.home_isolation === "shared"
    ) {
      context.addIssue({
        code: "custom",
        message: "permissions.codex.allow_network=true requires codex.home_isolation=isolated",
        path: ["permissions", "codex", "home_isolation"],
      });
    }

    for (const phase of runtimePhases) {
      try {
        validateCapabilitySelection({
          phase,
          provider: config.phases[phase].provider,
        });
      } catch (error) {
        context.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Invalid phase provider capability",
          path: ["phases", phase, "provider"],
        });
      }
    }
  });

export type AutokitConfig = z.output<typeof configSchema>;
export type PhaseConfig = AutokitConfig["phases"][RuntimePhase];
export type { EffortLevel, ResolvedEffort, UnsupportedEffortPolicy } from "./effort-resolver.js";

export class ConfigParseError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(message: string, issues: z.core.$ZodIssue[]) {
    super(message);
    this.name = "ConfigParseError";
    this.issues = issues;
  }
}

export const DEFAULT_CONFIG: AutokitConfig = configSchema.parse({});

export function resolveRunnerTimeout(
  config: AutokitConfig,
  phase: RuntimePhase,
  resolvedEffort?: Pick<ResolvedEffort, "timeout_ms"> | null,
): number {
  const explicitTimeout = phaseTimeoutValue(config, phase);
  if (explicitTimeout !== undefined) {
    return explicitTimeout;
  }
  if (resolvedEffort?.timeout_ms !== undefined) {
    return resolvedEffort.timeout_ms;
  }
  return config.runner_timeout.default_ms ?? defaultRunnerTimeoutMs[phase];
}

function phaseTimeoutValue(config: AutokitConfig, phase: RuntimePhase): number | undefined {
  switch (phase) {
    case "plan":
      return config.runner_timeout.plan_ms;
    case "plan_verify":
      return config.runner_timeout.plan_verify_ms;
    case "plan_fix":
      return config.runner_timeout.plan_fix_ms;
    case "implement":
      return config.runner_timeout.implement_ms;
    case "review":
      return config.runner_timeout.review_ms;
    case "supervise":
      return config.runner_timeout.supervise_ms;
    case "fix":
      return config.runner_timeout.fix_ms;
  }
}

export function parseConfigYaml(source: string): AutokitConfig {
  const document = parseDocument(source, {
    prettyErrors: false,
    stringKeys: true,
  });

  if (document.errors.length > 0) {
    throw new ConfigParseError(
      "Invalid config YAML",
      document.errors.map((error) => ({
        code: "custom",
        input: source,
        message: error.message,
        path: [],
      })),
    );
  }

  return parseConfig(document.toJSON());
}

export function parseConfig(value: unknown): AutokitConfig {
  const result = configSchema.safeParse(value ?? {});
  if (!result.success) {
    throw new ConfigParseError("Invalid autokit config", result.error.issues);
  }
  return result.data;
}

export function serializeConfigYaml(config: AutokitConfig = DEFAULT_CONFIG): string {
  return stringify(config);
}
