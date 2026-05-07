import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  sanitizeCommandOutput,
  validateGuardedCommand,
  validatePathAccess,
} from "./path-safety.ts";

describe("core path safety", () => {
  const workspaceRoot = "/repo/.autokit/worktrees/issue-90";

  it("denies secret paths and git state writes while allowing normal worktree writes", () => {
    for (const candidate of [
      ".env",
      ".env.local",
      ".codex/auth.json",
      ".claude/credentials.json",
      "id_rsa",
      "server.pem",
      "private.key",
    ]) {
      const decision = validatePathAccess({ workspaceRoot, candidate, access: "write" });
      assert.equal(decision.ok, false, `${candidate} must be denied`);
      assert.match(decision.reason, /secret|credential|key|env/i);
    }

    assert.deepEqual(
      validatePathAccess({ workspaceRoot, candidate: "src/foo.ts", access: "write" }),
      {
        ok: true,
      },
    );

    const gitState = validatePathAccess({
      workspaceRoot,
      candidate: ".git/config",
      access: "write",
    });
    assert.equal(gitState.ok, false);
    assert.match(gitState.reason, /\.git/);
  });

  it("allows only guarded read-only git and gh commands and blocks secret path args", () => {
    assert.deepEqual(validateGuardedCommand({ workspaceRoot, command: "git status --short" }), {
      ok: true,
      kind: "git",
      tokens: ["git", "status", "--short"],
    });
    assert.deepEqual(validateGuardedCommand({ workspaceRoot, command: "gh pr view 120" }), {
      ok: true,
      kind: "gh",
      tokens: ["gh", "pr", "view", "120"],
    });
    assert.equal(
      validateGuardedCommand({ workspaceRoot, command: "gh api --method GET repos/o/r" }).ok,
      true,
    );

    for (const command of [
      "git push origin HEAD",
      "git commit -m test",
      "git show HEAD:.env",
      "git diff -- .env",
      "gh pr merge 120",
      "gh issue close 90",
      "gh api --method POST repos/o/r/issues",
    ]) {
      const decision = validateGuardedCommand({ workspaceRoot, command });
      assert.equal(decision.ok, false, `${command} must be denied`);
    }
  });

  it("allows package test/build/lint/format scripts only as simple guarded commands", () => {
    for (const command of [
      "bun test",
      "bun run lint",
      "npm run build",
      "pnpm format",
      "yarn test",
    ]) {
      assert.equal(validateGuardedCommand({ workspaceRoot, command }).ok, true, command);
    }

    for (const command of ["bun run deploy", "npm run postinstall", "bun test && git push"]) {
      assert.equal(validateGuardedCommand({ workspaceRoot, command }).ok, false, command);
    }
  });

  it("denies package script bodies that bypass the guarded git/gh/path policy", () => {
    for (const scriptBody of [
      "/usr/bin/git commit -m bad",
      "/opt/homebrew/bin/gh pr merge 1",
      "cat .env",
    ]) {
      assert.equal(
        validateGuardedCommand({
          workspaceRoot,
          command: "bun test",
          packageScripts: { test: scriptBody },
        }).ok,
        false,
        scriptBody,
      );
    }
  });

  it("redacts guarded command output through the public sanitizer", () => {
    const output = sanitizeCommandOutput(
      `Bearer ghp_${"a".repeat(24)} at /repo/.autokit/worktrees/issue-90/.env`,
      { repoRoot: workspaceRoot, homeDir: "/Users/example" },
    );

    assert.equal(output.includes("ghp_"), false);
    assert.equal(output.includes(workspaceRoot), false);
    assert.match(output, /<repo>/);
  });
});
