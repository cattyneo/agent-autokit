import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGhPrCloseArgs, buildGhPrViewArgs, parseGhPrView } from "./gh.ts";
import {
  buildGitBranchDeleteArgs,
  buildGitRemoteBranchDeleteArgs,
  buildGitWorktreeRemoveArgs,
} from "./git.ts";
import { buildAutoMergeArgs, shouldPauseForHeadMismatch } from "./pr.ts";

describe("core git/gh/pr wrappers", () => {
  it("builds mockable git and gh command args without shell interpolation", () => {
    assert.deepEqual(buildGitWorktreeRemoveArgs(".autokit/worktrees/issue-8"), [
      "worktree",
      "remove",
      ".autokit/worktrees/issue-8",
    ]);
    assert.deepEqual(buildGitWorktreeRemoveArgs(".autokit/worktrees/issue-8", { force: true }), [
      "worktree",
      "remove",
      "--force",
      ".autokit/worktrees/issue-8",
    ]);
    assert.deepEqual(buildGitBranchDeleteArgs("autokit/issue-8"), [
      "branch",
      "-D",
      "autokit/issue-8",
    ]);
    assert.deepEqual(buildGitRemoteBranchDeleteArgs("autokit/issue-8"), [
      "push",
      "origin",
      "--delete",
      "autokit/issue-8",
    ]);
    assert.deepEqual(buildGhPrViewArgs(28), [
      "pr",
      "view",
      "28",
      "--json",
      "state,mergedAt,headRefOid,mergeable",
    ]);
    assert.deepEqual(buildGhPrCloseArgs(28), [
      "pr",
      "close",
      "28",
      "--delete-branch",
      "--comment",
      "autokit retry: superseded",
    ]);
  });

  it("parses PR observations and builds auto-merge reservation args", () => {
    assert.deepEqual(
      parseGhPrView({
        state: "MERGED",
        mergedAt: "2026-05-04T10:08:34Z",
        headRefOid: "abc",
        mergeable: "MERGEABLE",
      }),
      { state: "MERGED", merged: true, headRefOid: "abc", mergeable: "MERGEABLE" },
    );
    assert.equal(
      parseGhPrView({
        state: "OPEN",
        mergedAt: null,
        headRefOid: "abc",
        mergeable: "MERGEABLE",
      }).merged,
      false,
    );
    assert.equal(shouldPauseForHeadMismatch("abc", "def"), true);
    assert.deepEqual(buildAutoMergeArgs(28, "abc"), [
      "pr",
      "merge",
      "28",
      "--auto",
      "--rebase",
      "--match-head-commit",
      "abc",
    ]);
  });
});
