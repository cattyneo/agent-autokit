import { parseDocument } from "yaml";
import * as z from "zod";

import {
  capabilityPhases,
  capabilityProviders,
  type Provider,
  validateCapabilitySelection,
} from "./capability.js";

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

function phaseSchema(phase: RuntimePhase) {
  return z
    .strictObject({
      provider: providerSchema.default(defaultPhaseProviders[phase]),
      model: modelNameSchema.default("auto"),
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
        plan_ms: positiveInteger.default(600_000),
        plan_verify_ms: positiveInteger.optional(),
        plan_fix_ms: positiveInteger.optional(),
        implement_ms: positiveInteger.default(1_800_000),
        review_ms: positiveInteger.default(600_000),
        supervise_ms: positiveInteger.optional(),
        fix_ms: positiveInteger.optional(),
        default_ms: positiveInteger.default(600_000),
        plan_idle_ms: positiveInteger.optional(),
        plan_verify_idle_ms: positiveInteger.optional(),
        plan_fix_idle_ms: positiveInteger.optional(),
        implement_idle_ms: positiveInteger.optional(),
        review_idle_ms: positiveInteger.optional(),
        supervise_idle_ms: positiveInteger.optional(),
        fix_idle_ms: positiveInteger.optional(),
        default_idle_ms: positiveInteger.default(300_000),
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

export class ConfigParseError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(message: string, issues: z.core.$ZodIssue[]) {
    super(message);
    this.name = "ConfigParseError";
    this.issues = issues;
  }
}

export const DEFAULT_CONFIG: AutokitConfig = configSchema.parse({});

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
