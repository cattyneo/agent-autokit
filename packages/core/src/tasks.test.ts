import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse, stringify } from "yaml";

import {
  createTaskEntry,
  loadTasksFile,
  type TaskEntry,
  TaskFileParseError,
  taskAgentPhases,
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
    assert.equal(task.provider_sessions.fix.claude_session_id, null);
    assert.equal(task.provider_sessions.fix.last_provider, null);
    assert.equal(task.runtime.resolved_model.review, null);
    assert.equal(task.runtime.resolved_effort, null);
    assert.equal(task.runtime.phase_self_correct_done, null);
    assert.equal(task.runtime.phase_override, null);
    assert.deepEqual(task.review_findings, []);
    assert.equal(task.cleaning_progress.worktree_remove_attempts, 0);
    assert.deepEqual(task.cached.labels_at_add, ["agent-ready"]);
  });

  it("round-trips new runtime fields and provider session shape", () => {
    const root = makeTempDir();
    const path = join(root, "tasks.yaml");
    const task = createTaskEntry({
      issue: 88,
      slug: "taskentry-runtime",
      title: "TaskEntry runtime",
      labels: [],
      now: "2026-05-07T10:00:00+09:00",
    });
    task.provider_sessions.plan = {
      claude_session_id: "claude-plan",
      codex_session_id: "codex-plan",
      last_provider: "codex",
    };
    task.provider_sessions.implement = {
      claude_session_id: "claude-implement",
      codex_session_id: "codex-implement",
      last_provider: "claude",
    };
    task.runtime.resolved_effort = {
      phase: "implement",
      provider: "codex",
      effort: "high",
      downgraded_from: null,
      timeout_ms: 3_600_000,
    };
    task.runtime.phase_self_correct_done = false;
    task.runtime.phase_override = {
      phase: "review",
      provider: "claude",
      effort: "medium",
      expires_at_run_id: "run-1",
    };

    writeTasksFileAtomic(path, {
      version: 1,
      generated_at: "2026-05-07T10:00:00+09:00",
      tasks: [task],
    });

    const loaded = loadTasksFile(path).tasks[0];
    assert.deepEqual(loaded.provider_sessions.plan, {
      claude_session_id: "claude-plan",
      codex_session_id: "codex-plan",
      last_provider: "codex",
    });
    assert.deepEqual(loaded.runtime.phase_override, {
      phase: "review",
      provider: "claude",
      effort: "medium",
      expires_at_run_id: "run-1",
    });
  });

  it("migrates legacy provider session fixtures to the v0.2 shape", () => {
    const fixtureRoot = join(process.cwd(), "e2e", "fixtures", "legacy-tasks-yaml");

    for (const file of readdirSync(fixtureRoot).filter((entry) => entry.endsWith(".yaml"))) {
      const root = makeTempDir();
      const path = join(root, "tasks.yaml");
      const fixture = parse(readFileSync(join(fixtureRoot, file), "utf8")) as {
        phase: (typeof taskAgentPhases)[number];
        expected_last_provider: "claude" | "codex";
        provider_sessions: Partial<
          Record<(typeof taskAgentPhases)[number], Partial<TaskEntry["provider_sessions"]["plan"]>>
        >;
      };
      const task = createTaskEntry({
        issue: 88,
        slug: file.replace(/\.yaml$/, ""),
        title: file,
        labels: [],
        now: "2026-05-07T10:00:00+09:00",
      });
      writeFileSync(
        path,
        stringify({
          version: 1,
          generated_at: "2026-05-07T10:00:00+09:00",
          tasks: [
            {
              ...task,
              provider_sessions: { ...task.provider_sessions, ...fixture.provider_sessions },
            },
          ],
        }),
        { mode: 0o600 },
      );

      const loaded = loadTasksFile(path).tasks[0];
      assert.equal(
        loaded.provider_sessions[fixture.phase].last_provider,
        fixture.expected_last_provider,
        file,
      );
      assert.equal(
        loaded.provider_sessions[fixture.phase].claude_session_id,
        fixture.provider_sessions[fixture.phase]?.claude_session_id ?? null,
        file,
      );
      assert.equal(
        loaded.provider_sessions[fixture.phase].codex_session_id,
        fixture.provider_sessions[fixture.phase]?.codex_session_id ?? null,
        file,
      );
    }
  });

  it("accepts empty legacy sessions and normalizes last_provider to null", () => {
    const root = makeTempDir();
    const path = join(root, "tasks.yaml");
    const task = createTaskEntry({
      issue: 88,
      slug: "empty-sessions",
      title: "empty",
      labels: [],
      now: "2026-05-07T10:00:00+09:00",
    });

    writeFileSync(
      path,
      stringify({
        version: 1,
        generated_at: "2026-05-07T10:00:00+09:00",
        tasks: [
          {
            ...task,
            provider_sessions: {
              plan: { claude_session_id: null },
              plan_verify: { codex_session_id: null },
              plan_fix: { claude_session_id: null },
              implement: { codex_session_id: null },
              review: null,
              supervise: { claude_session_id: null },
              fix: { codex_session_id: null },
            },
          },
        ],
      }),
      { mode: 0o600 },
    );

    const loaded = loadTasksFile(path).tasks[0];
    for (const phase of taskAgentPhases) {
      assert.equal(loaded.provider_sessions[phase].last_provider, null);
    }
  });

  it("round-trips supervisor reject reasons in review findings", () => {
    const root = makeTempDir();
    const path = join(root, "tasks.yaml");
    const task = createTaskEntry({
      issue: 12,
      slug: "ak-011",
      title: "AK-011",
      labels: [],
      now: "2026-05-04T10:00:00+09:00",
    });
    task.review_findings.push({
      round: 1,
      accept_ids: ["finding-a"],
      reject_ids: ["finding-b"],
      reject_reasons: { "finding-b": "Known acceptable trade-off." },
    });

    writeTasksFileAtomic(path, {
      version: 1,
      generated_at: "2026-05-04T10:01:00+09:00",
      tasks: [task],
    });

    const loaded = loadTasksFile(path);
    assert.deepEqual(loaded.tasks[0].review_findings[0], {
      round: 1,
      accept_ids: ["finding-a"],
      reject_ids: ["finding-b"],
      reject_reasons: { "finding-b": "Known acceptable trade-off." },
    });
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
