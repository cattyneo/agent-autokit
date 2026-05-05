import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGhIssueViewBodyArgs,
  buildGhPrCloseArgs,
  buildGhPrCreateDraftArgs,
  buildGhPrListHeadArgs,
  buildGhPrReadyArgs,
  buildGhPrViewArgs,
  buildGhPrViewCiArgs,
  buildGhPrViewHeadArgs,
  buildGhPrViewMergeArgs,
  parseGhPrView,
} from "./gh.ts";
import {
  buildGitAddAllArgs,
  buildGitBranchDeleteArgs,
  buildGitCommitArgs,
  buildGitFetchArgs,
  buildGitPushSetUpstreamArgs,
  buildGitRebaseArgs,
  buildGitRemoteBranchDeleteArgs,
  buildGitRevParseHeadArgs,
  buildGitWorktreeAddArgs,
  buildGitWorktreeAddExistingBranchArgs,
  buildGitWorktreePruneArgs,
  buildGitWorktreeRemoveArgs,
} from "./git.ts";
import { buildAutoMergeArgs, buildDisableAutoMergeArgs, shouldPauseForHeadMismatch } from "./pr.ts";

describe("core git/gh/pr wrappers", () => {
  it("builds mockable git and gh command args without shell interpolation", () => {
    assert.deepEqual(buildGitWorktreeRemoveArgs(".autokit/worktrees/issue-8"), [
      "worktree",
      "remove",
      ".autokit/worktrees/issue-8",
    ]);
    assert.deepEqual(
      buildGitWorktreeAddArgs({
        worktreePath: ".autokit/worktrees/issue-8",
        branch: "autokit/issue-8",
        baseRef: "origin/main",
      }),
      ["worktree", "add", "-b", "autokit/issue-8", ".autokit/worktrees/issue-8", "origin/main"],
    );
    assert.deepEqual(
      buildGitWorktreeAddExistingBranchArgs({
        worktreePath: ".autokit/worktrees/issue-8",
        branch: "autokit/issue-8",
      }),
      ["worktree", "add", ".autokit/worktrees/issue-8", "autokit/issue-8"],
    );
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
    assert.deepEqual(buildGitRevParseHeadArgs(), ["rev-parse", "HEAD"]);
    assert.deepEqual(buildGitFetchArgs("origin", "main"), ["fetch", "origin", "main"]);
    assert.deepEqual(buildGitAddAllArgs(), ["add", "-A"]);
    assert.deepEqual(buildGitCommitArgs("message"), ["commit", "-m", "message"]);
    assert.deepEqual(buildGitPushSetUpstreamArgs("autokit/issue-8"), [
      "push",
      "-u",
      "origin",
      "autokit/issue-8",
    ]);
    assert.deepEqual(buildGitRebaseArgs("origin/main"), ["rebase", "origin/main"]);
    assert.deepEqual(buildGitWorktreePruneArgs(), ["worktree", "prune"]);
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
    assert.deepEqual(buildGhPrViewHeadArgs(28), [
      "pr",
      "view",
      "28",
      "--json",
      "headRefOid,baseRefOid",
    ]);
    assert.deepEqual(buildGhPrViewCiArgs(28), ["pr", "view", "28", "--json", "statusCheckRollup"]);
    assert.deepEqual(buildGhPrViewMergeArgs(28), [
      "pr",
      "view",
      "28",
      "--json",
      "headRefOid,mergeable,autoMergeRequest",
    ]);
    assert.deepEqual(buildGhPrListHeadArgs("autokit/issue-8"), [
      "pr",
      "list",
      "--head",
      "autokit/issue-8",
      "--state",
      "all",
      "--json",
      "number,state,headRefOid,baseRefOid",
      "--limit",
      "1",
    ]);
    assert.deepEqual(
      buildGhPrCreateDraftArgs({
        title: "Title",
        body: "Body",
        head: "autokit/issue-8",
        base: "main",
      }),
      [
        "pr",
        "create",
        "--draft",
        "--title",
        "Title",
        "--body",
        "Body",
        "--head",
        "autokit/issue-8",
        "--base",
        "main",
      ],
    );
    assert.deepEqual(buildGhPrReadyArgs(28), ["pr", "ready", "28"]);
    assert.deepEqual(buildGhIssueViewBodyArgs(8), [
      "issue",
      "view",
      "8",
      "--json",
      "number,title,body,labels,state,url",
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
    assert.deepEqual(buildDisableAutoMergeArgs(28), ["pr", "merge", "28", "--disable-auto"]);
  });
});
