import {
  type AutokitConfig,
  type PhaseConfig,
  type RuntimePhase,
  runtimePhases,
} from "./config.ts";

export type ResolvedModels = Record<RuntimePhase, string | null>;
export type ModelResolver = (phase: RuntimePhase, phaseConfig: PhaseConfig) => string;

export type ResolveModelsOptions = {
  existing?: Partial<ResolvedModels>;
  resolveAutoModel?: ModelResolver;
};

export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

export function createEmptyResolvedModels(): ResolvedModels {
  return {
    plan: null,
    plan_verify: null,
    plan_fix: null,
    implement: null,
    review: null,
    supervise: null,
    fix: null,
  };
}

export function resolveModelsForPlanning(
  config: AutokitConfig,
  options: ResolveModelsOptions = {},
): Record<RuntimePhase, string> {
  const resolved = createEmptyResolvedModels();

  for (const phase of runtimePhases) {
    const existingModel = normalizeModel(options.existing?.[phase]);
    if (existingModel !== undefined) {
      resolved[phase] = existingModel;
      continue;
    }

    const configuredModel = config.phases[phase].model;
    if (configuredModel !== "auto") {
      resolved[phase] = configuredModel;
      continue;
    }

    if (options.resolveAutoModel === undefined) {
      throw new ModelResolutionError(`model:auto cannot be resolved for ${phase}`);
    }

    const autoModel = normalizeModel(options.resolveAutoModel(phase, config.phases[phase]));
    if (autoModel === undefined) {
      throw new ModelResolutionError(`model:auto resolver returned empty model for ${phase}`);
    }
    resolved[phase] = autoModel;
  }

  return resolved as Record<RuntimePhase, string>;
}

function normalizeModel(model: string | null | undefined): string | undefined {
  if (model === null || model === undefined) {
    return undefined;
  }
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
