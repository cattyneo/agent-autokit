import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  capabilities,
  derive_claude_perm,
  derive_codex_perm,
  runtimePhases,
  validateCapabilitySelection,
} from "./index.ts";

describe("core capability table", () => {
  it("exports all 14 phase/provider rows as the core SoT", () => {
    assert.equal(capabilities.length, runtimePhases.length * 2);
    assert.deepEqual(
      capabilities.map((row) => `${row.phase}:${row.provider}:${row.permission_profile}`),
      [
        "plan:claude:readonly_repo",
        "plan:codex:readonly_repo",
        "plan_verify:claude:readonly_repo",
        "plan_verify:codex:readonly_repo",
        "plan_fix:claude:readonly_repo",
        "plan_fix:codex:readonly_repo",
        "implement:claude:write_worktree",
        "implement:codex:write_worktree",
        "review:claude:readonly_worktree",
        "review:codex:readonly_worktree",
        "supervise:claude:readonly_worktree",
        "supervise:codex:readonly_worktree",
        "fix:claude:write_worktree",
        "fix:codex:write_worktree",
      ],
    );
  });

  it("derives provider permissions from the phase profile", () => {
    assert.deepEqual(derive_claude_perm("plan"), {
      allowed_tools: ["Read", "Grep", "Glob"],
      denied_tools: ["Bash", "Edit", "Write", "WebFetch", "WebSearch"],
      hook: "readonly_path_guard",
    });
    assert.equal(derive_claude_perm("implement").hook, "write_path_guard");
    assert.deepEqual(derive_codex_perm("plan"), { sandbox: "read-only", network: "off" });
    assert.deepEqual(derive_codex_perm("implement"), {
      sandbox: "workspace-write",
      network: "off",
    });
  });

  it("keeps read-only profiles fail-closed for write and network-capable Claude tools", () => {
    for (const phase of ["plan", "plan_verify", "plan_fix", "review", "supervise"] as const) {
      const permission = derive_claude_perm(phase);

      for (const denied of ["Edit", "Write", "Bash", "WebFetch", "WebSearch"]) {
        assert.equal(permission.denied_tools.includes(denied), true, `${phase} denies ${denied}`);
      }
    }
  });

  it("rejects combinations outside the capability table", () => {
    assert.equal(validateCapabilitySelection({ phase: "plan", provider: "claude" }).phase, "plan");
    assert.throws(
      () => validateCapabilitySelection({ phase: "unknown", provider: "claude" }),
      /Unsupported capability phase/,
    );
    assert.throws(
      () => validateCapabilitySelection({ phase: "plan", provider: "other" }),
      /Unsupported capability provider/,
    );
    assert.throws(
      () => validateCapabilitySelection({ phase: "ci_wait", provider: "codex" }),
      /core-only phase/,
    );
    assert.throws(
      () => validateCapabilitySelection({ phase: "merge", provider: "claude" }),
      /core-only phase/,
    );
  });
});
