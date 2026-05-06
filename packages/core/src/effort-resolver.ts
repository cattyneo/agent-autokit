import type { Phase, Provider } from "./capability.js";
import type { FailureCode } from "./failure-codes.js";

export const effortLevels = ["auto", "low", "medium", "high"] as const;
export const unsupportedEffortPolicies = ["fail", "downgrade"] as const;

export type EffortLevel = (typeof effortLevels)[number];
export type UnsupportedEffortPolicy = (typeof unsupportedEffortPolicies)[number];

export type ResolvedEffort = {
  phase: Phase;
  provider: Provider;
  effort: EffortLevel;
  downgraded_from: EffortLevel | null;
  timeout_ms: number;
};

export type EffortDowngradeAuditCandidate = {
  kind: "effort_downgrade";
  phase: Phase;
  provider: Provider;
  model: string;
  from: EffortLevel;
  to: EffortLevel;
};

export type EffortResolutionInput = {
  phase: Phase;
  provider: Provider;
  effort: EffortLevel;
  model: string;
  unsupported_policy: UnsupportedEffortPolicy;
  timeout_ms: number;
};

export type EffortResolutionResult =
  | {
      ok: true;
      resolved: ResolvedEffort;
      audit: EffortDowngradeAuditCandidate | null;
    }
  | {
      ok: false;
      failure: {
        code: Extract<FailureCode, "effort_unsupported">;
        message: string;
      };
    };

export type PhaseOverride = {
  phase: Phase;
  provider?: Provider;
  effort?: EffortLevel;
  expires_at_run_id: string;
};

const downgradeStep = {
  high: "medium",
  medium: "low",
  low: "auto",
  auto: null,
} as const satisfies Record<EffortLevel, EffortLevel | null>;

export function resolveEffort(input: EffortResolutionInput): EffortResolutionResult {
  if (isSupportedEffort(input.provider, input.model, input.effort)) {
    return {
      ok: true,
      resolved: {
        phase: input.phase,
        provider: input.provider,
        effort: input.effort,
        downgraded_from: null,
        timeout_ms: input.timeout_ms,
      },
      audit: null,
    };
  }

  if (input.unsupported_policy === "downgrade") {
    const downgraded = downgradeStep[input.effort];
    if (downgraded !== null && isSupportedEffort(input.provider, input.model, downgraded)) {
      return {
        ok: true,
        resolved: {
          phase: input.phase,
          provider: input.provider,
          effort: downgraded,
          downgraded_from: input.effort,
          timeout_ms: input.timeout_ms,
        },
        audit: {
          kind: "effort_downgrade",
          phase: input.phase,
          provider: input.provider,
          model: input.model,
          from: input.effort,
          to: downgraded,
        },
      };
    }
  }

  return {
    ok: false,
    failure: {
      code: "effort_unsupported",
      message: `unsupported effort tuple: effort=${input.effort} provider=${input.provider} model=${input.model}`,
    },
  };
}

function isSupportedEffort(provider: Provider, model: string, effort: EffortLevel): boolean {
  const normalizedModel = model.toLowerCase();
  if (normalizedModel.includes("unsupported-all-efforts")) {
    return false;
  }
  if (effort === "auto") {
    return true;
  }
  if (provider === "codex" && effort === "high" && normalizedModel.includes("gpt-5.4-mini")) {
    return false;
  }
  if (provider === "claude" && effort === "high" && normalizedModel.includes("haiku")) {
    return false;
  }
  return true;
}
