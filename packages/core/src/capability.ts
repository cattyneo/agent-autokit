export const capabilityPhases = [
  "plan",
  "plan_verify",
  "plan_fix",
  "implement",
  "review",
  "supervise",
  "fix",
] as const;
export const capabilityProviders = ["claude", "codex"] as const;

export type Phase = (typeof capabilityPhases)[number];
export type Provider = (typeof capabilityProviders)[number];

export type PermissionProfile = "readonly_repo" | "readonly_worktree" | "write_worktree";
export type ClaudeHook = "readonly_path_guard" | "write_path_guard";
export type ClaudePermission = {
  allowed_tools: string[];
  denied_tools: string[];
  hook: ClaudeHook;
};
export type CodexPermission = {
  sandbox: "read-only" | "workspace-write";
  network: "off";
};
export type CapabilityRow = {
  phase: Phase;
  provider: Provider;
  permission_profile: PermissionProfile;
};

export class CapabilityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityValidationError";
  }
}

const coreOnlyPhases = ["ci_wait", "merge"] as const;
const phasePermissionProfiles = {
  plan: "readonly_repo",
  plan_verify: "readonly_repo",
  plan_fix: "readonly_repo",
  implement: "write_worktree",
  review: "readonly_worktree",
  supervise: "readonly_worktree",
  fix: "write_worktree",
} as const satisfies Record<Phase, PermissionProfile>;

const readOnlyClaudeTools = ["Read", "Grep", "Glob"] as const;
const writeClaudeTools = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"] as const;
const readOnlyDeniedClaudeTools = ["Bash", "Edit", "Write", "WebFetch", "WebSearch"] as const;
const writeDeniedClaudeTools = ["WebFetch", "WebSearch"] as const;

export const capabilities: readonly CapabilityRow[] = capabilityPhases.flatMap((phase) =>
  capabilityProviders.map((provider) => ({
    phase,
    provider,
    permission_profile: phasePermissionProfiles[phase],
  })),
);

export function derive_claude_perm(phase: Phase): ClaudePermission {
  const profile = permissionProfileForPhase(phase);
  if (profile === "write_worktree") {
    return {
      allowed_tools: [...writeClaudeTools],
      denied_tools: [...writeDeniedClaudeTools],
      hook: "write_path_guard",
    };
  }

  return {
    allowed_tools: [...readOnlyClaudeTools],
    denied_tools: [...readOnlyDeniedClaudeTools],
    hook: "readonly_path_guard",
  };
}

export function derive_codex_perm(phase: Phase): CodexPermission {
  const profile = permissionProfileForPhase(phase);
  return {
    sandbox: profile === "write_worktree" ? "workspace-write" : "read-only",
    network: "off",
  };
}

export const deriveClaudePerm = derive_claude_perm;
export const deriveCodexPerm = derive_codex_perm;

export function validateCapabilitySelection(input: {
  phase: unknown;
  provider: unknown;
}): CapabilityRow {
  const phase = validatePhase(input.phase);
  const provider = validateProvider(input.provider);
  const row = capabilities.find(
    (candidate) => candidate.phase === phase && candidate.provider === provider,
  );
  if (row === undefined) {
    throw new CapabilityValidationError(
      `Unsupported capability combination: phase=${phase}, provider=${provider}`,
    );
  }
  return row;
}

export function isCapabilityPhase(value: unknown): value is Phase {
  return typeof value === "string" && (capabilityPhases as readonly string[]).includes(value);
}

export function isCapabilityProvider(value: unknown): value is Provider {
  return typeof value === "string" && (capabilityProviders as readonly string[]).includes(value);
}

function permissionProfileForPhase(phase: Phase): PermissionProfile {
  return phasePermissionProfiles[phase];
}

function validatePhase(value: unknown): Phase {
  if (typeof value !== "string") {
    throw new CapabilityValidationError("Unsupported capability phase: expected string");
  }
  if ((coreOnlyPhases as readonly string[]).includes(value)) {
    throw new CapabilityValidationError(`Cannot assign provider to core-only phase: ${value}`);
  }
  if (!isCapabilityPhase(value)) {
    throw new CapabilityValidationError(`Unsupported capability phase: ${value}`);
  }
  return value;
}

function validateProvider(value: unknown): Provider {
  if (!isCapabilityProvider(value)) {
    throw new CapabilityValidationError(`Unsupported capability provider: ${String(value)}`);
  }
  return value;
}
