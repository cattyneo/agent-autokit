import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createTaskEntry,
  loadTasksFile,
  TaskFileParseError,
  writeTasksFileAtomic,
} from "./tasks.ts";

describe("core tasks file", () => {
  it("creates SPEC-shaped task defaults", () => {
    const task = createTaskEntry({
      issue: 8,
      slug: "core-tasks-state-reconcile-retry",
      title: "AK-007",
      labels: ["agent-ready"],
      now: "2026-05-04T10:00:00+09:00",
    });

    assert.equal(task.state, "queued");
    assert.equal(task.runtime_phase, null);
    assert.equal(task.pr.number, null);
    assert.equal(task.plan.state, "pending");
    assert.equal(task.git.checkpoints.implement.pr_created, null);
    assert.equal(task.provider_sessions.fix.codex_session_id, null);
    assert.equal(task.runtime.resolved_model.review, null);
    assert.equal(task.cleaning_progress.worktree_remove_attempts, 0);
    assert.deepEqual(task.cached.labels_at_add, ["agent-ready"]);
  });

  it("writes tasks.yaml atomically, keeps .bak, and uses 0600 mode", () => {
    const root = makeTempDir();
    const path = join(root, "tasks.yaml");
    writeFileSync(path, "version: 1\ngenerated_at: old\ntasks: []\n", { mode: 0o600 });

    const task = createTaskEntry({
      issue: 8,
      slug: "ak-007",
      title: "AK-007",
      labels: [],
      now: "2026-05-04T10:00:00+09:00",
    });
    writeTasksFileAtomic(path, {
      version: 1,
      generated_at: "2026-05-04T10:00:00+09:00",
      tasks: [task],
    });

    assert.equal(existsSync(`${path}.tmp`), false);
    assert.equal(existsSync(`${path}.bak`), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const loaded = loadTasksFile(path);
    assert.equal(loaded.tasks[0].issue, 8);
  });

  it("restores from .bak on parse failure only when explicitly confirmed", () => {
    const root = makeTempDir();
    const path = join(root, "tasks.yaml");
    const backup = "version: 1\ngenerated_at: backup\ntasks: []\n";
    writeFileSync(path, "version: [", { mode: 0o600 });
    writeFileSync(`${path}.bak`, backup, { mode: 0o600 });

    assert.throws(() => loadTasksFile(path), TaskFileParseError);

    const loaded = loadTasksFile(path, { restoreFromBackup: true });
    assert.equal(loaded.generated_at, "backup");
    assert.equal(readFileSync(path, "utf8"), backup);
  });

  it("treats a 0-byte tasks.yaml as corruption instead of an empty queue", () => {
    const root = makeTempDir();
    const path = join(root, "tasks.yaml");
    writeFileSync(path, "", { mode: 0o600 });

    assert.throws(() => loadTasksFile(path), TaskFileParseError);
  });

  it("rejects task entries that drift from the SPEC schema", () => {
    const root = makeTempDir();
    const path = join(root, "tasks.yaml");
    writeFileSync(path, "version: 1\ngenerated_at: now\ntasks:\n  - issue: 8\n    state: done\n", {
      mode: 0o600,
    });

    assert.throws(() => loadTasksFile(path), TaskFileParseError);
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autokit-tasks-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}
