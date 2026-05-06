import type { Phase, Provider } from "./capability.js";

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

export type PhaseOverride = {
  phase: Phase;
  provider?: Provider;
  effort?: EffortLevel;
  expires_at_run_id: string;
};
