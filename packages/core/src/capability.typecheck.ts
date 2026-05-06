import { derive_claude_perm, derive_codex_perm, type Phase } from "./capability.js";

const validPhase: Phase = "plan";
derive_claude_perm(validPhase);
derive_codex_perm("fix");

// @ts-expect-error core-only runtime phases are not provider capability phases.
const ciWaitPhase: Phase = "ci_wait";
void ciWaitPhase;

// @ts-expect-error merge is a core-only runtime phase, not an agent capability phase.
derive_claude_perm("merge");

// @ts-expect-error unknown phases cannot derive Codex permissions.
derive_codex_perm("unknown");
