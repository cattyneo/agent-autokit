import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createTaskEntry,
  type TaskEntry,
  writeTasksFileAtomic,
} from "../../packages/core/src/index.ts";
import { type GhJsonRunner, verifyUnprotectedSmoke } from "./full-run.ts";

describe("full integration smoke evidence", () => {
  it("verifies OBS-01 through OBS-11 for a completed unprotected smoke", async () => {
    const repo = await createSmokeRepo();
    const result = verifyUnprotectedSmoke({
      repoPath: repo,
      ownerRepo: "cattyneo/agent-autokit-e2e-fixture",
      issue: 1,
      runExitCode: 0,
      gh: fakeGh({
        prMerged: true,
        branchExists: false,
      }),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.observations.map((observation) => [observation.id, observation.passed]),
      [
        ["OBS-01", true],
        ["OBS-02", true],
        ["OBS-03", true],
        ["OBS-04", true],
        ["OBS-05", true],
        ["OBS-06", true],
        ["OBS-07", true],
        ["OBS-08", true],
        ["OBS-09", true],
        ["OBS-10", true],
        ["OBS-11", true],
      ],
    );
  });

  it("fails closed when required audit evidence is missing or branch still exists", async () => {
    const repo = await createSmokeRepo({ omitBranchDeletedAudit: true });
    const result = verifyUnprotectedSmoke({
      repoPath: repo,
      ownerRepo: "cattyneo/agent-autokit-e2e-fixture",
      issue: 1,
      runExitCode: 0,
      gh: fakeGh({
        prMerged: true,
        branchExists: true,
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.observations.find((observation) => observation.id === "OBS-06")?.passed,
      false,
    );
    assert.equal(
      result.observations.find((observation) => observation.id === "OBS-10")?.passed,
      false,
    );
  });

  it("fails closed on any failure audit kind", async () => {
    const repo = await createSmokeRepo({ extraAuditKind: "prompt_contract_violation" });
    const result = verifyUnprotectedSmoke({
      repoPath: repo,
      ownerRepo: "cattyneo/agent-autokit-e2e-fixture",
      issue: 1,
      runExitCode: 0,
      gh: fakeGh({
        prMerged: true,
        branchMode: "missing",
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.observations.find((observation) => observation.id === "OBS-07")?.passed,
      false,
    );
  });

  it("requires HTTP 404 evidence for remote branch deletion", async () => {
    const repo = await createSmokeRepo();
    const result = verifyUnprotectedSmoke({
      repoPath: repo,
      ownerRepo: "cattyneo/agent-autokit-e2e-fixture",
      issue: 1,
      runExitCode: 0,
      gh: fakeGh({
        prMerged: true,
        branchMode: "auth-error",
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.observations.find((observation) => observation.id === "OBS-10")?.passed,
      false,
    );
  });
});

async function createSmokeRepo(
  options: { omitBranchDeletedAudit?: boolean; extraAuditKind?: string } = {},
): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "autokit-full-run-test-"));
  mkdirSync(join(repo, ".autokit", "logs"), { recursive: true });
  mkdirSync(join(repo, ".autokit", "reviews"), { recursive: true });

  writeFileSync(
    join(repo, ".autokit", "config.yaml"),
    [
      "version: 1",
      "review:",
      "  max_rounds: 3",
      "ci:",
      "  fix_max_rounds: 3",
      "runtime:",
      "  max_untrusted_input_kb: 256",
    ].join("\n"),
  );

  writeTasksFileAtomic(join(repo, ".autokit", "tasks.yaml"), {
    version: 1,
    generated_at: "2026-05-05T00:00:00Z",
    tasks: [mergedTask()],
  });

  writeFileSync(join(repo, ".autokit", "reviews", "issue-1-review-1.md"), "# Review\n");
  writeFileSync(
    join(repo, ".autokit", "logs", "2026-05-05.log"),
    [
      JSON.stringify({
        level: "info",
        event: "audit",
        kind: "sanitize_pass_hmac",
        sanitize_hmac: "abc123",
      }),
      JSON.stringify({ level: "info", event: "audit", kind: "auto_merge_reserved" }),
      options.omitBranchDeletedAudit
        ? null
        : JSON.stringify({ level: "info", event: "audit", kind: "branch_deleted" }),
      options.extraAuditKind
        ? JSON.stringify({ level: "info", event: "audit", kind: options.extraAuditKind })
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return repo;
}

function mergedTask(): TaskEntry {
  const task = createTaskEntry({
    issue: 1,
    slug: "fix-off-by-one-in-pagination-calc",
    title: "Fix: off-by-one in pagination calc",
    labels: ["bug", "agent-ready"],
    now: "2026-05-05T00:00:00Z",
  });
  return {
    ...task,
    state: "merged",
    pr: {
      number: 2,
      head_sha: "head-sha",
      base_sha: "base-sha",
      created_at: "2026-05-05T00:00:00Z",
    },
    review_round: 0,
    ci_fix_round: 0,
    failure: null,
    cleaning_progress: {
      grace_period_done: true,
      branch_deleted_done: true,
      worktree_removed_done: true,
      finalized_done: true,
      worktree_remove_attempts: 0,
    },
  };
}

function fakeGh(options: {
  prMerged: boolean;
  branchExists?: boolean;
  branchMode?: "missing" | "exists" | "auth-error";
}): GhJsonRunner {
  const branchMode = options.branchMode ?? (options.branchExists ? "exists" : "missing");
  return (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return {
        ok: true,
        stdout: options.prMerged
          ? { state: "MERGED", mergedAt: "2026-05-05T00:00:00Z", headRefOid: "head-sha" }
          : { state: "OPEN", mergedAt: null, headRefOid: "head-sha" },
        status: 0,
      };
    }
    if (args[0] === "api") {
      if (branchMode === "exists") {
        return { ok: true, stdout: { name: "autokit/issue-1" }, status: 0 };
      }
      if (branchMode === "auth-error") {
        return { ok: false, stderr: "gh: Bad credentials (HTTP 401)", status: 1 };
      }
      return { ok: false, stderr: "gh: Branch not found (HTTP 404)", status: 1 };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
}
