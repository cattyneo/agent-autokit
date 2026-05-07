import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { type CliDeps, runCli } from "../../packages/cli/src/index.ts";
import {
  createTaskEntry,
  loadTasksFile,
  parseConfigYaml,
  resolveRunnerTimeout,
  type TaskEntry,
  taskAgentPhases,
  type WriteTaskInput,
  writeTasksFileAtomic,
} from "../../packages/core/src/index.ts";

const NOW = "2026-05-08T14:00:00.000Z";

type AgentPhase = (typeof taskAgentPhases)[number];
type LegacySessionFixture = {
  phase: AgentPhase;
  expected_last_provider: "claude" | "codex";
  provider_sessions: Partial<Record<AgentPhase, Partial<TaskEntry["provider_sessions"]["plan"]>>>;
};

describe("Issue #115 legacy compatibility E2E gate", () => {
  it("resumes all legacy provider session fixtures through the CLI parse/write gate", async () => {
    const fixtureRoot = join(process.cwd(), "e2e", "fixtures", "legacy-tasks-yaml");
    const fixtureFiles = readdirSync(fixtureRoot)
      .filter((entry) => entry.endsWith(".yaml"))
      .sort();
    assert.equal(fixtureFiles.length, taskAgentPhases.length * 2);
    assert.deepEqual(
      fixtureFiles.filter((entry) => entry.endsWith("-default-provider.yaml")).sort(),
      taskAgentPhases.map((phase) => `${phase.replaceAll("_", "-")}-default-provider.yaml`).sort(),
    );
    assert.deepEqual(
      fixtureFiles.filter((entry) => entry.endsWith("-both-sessions.yaml")).sort(),
      taskAgentPhases.map((phase) => `${phase.replaceAll("_", "-")}-both-sessions.yaml`).sort(),
    );

    for (const file of fixtureFiles) {
      const fixture = parseLegacySessionFixture(readFileSync(join(fixtureRoot, file), "utf8"));
      const repo = makeRepo();
      const legacyTask = legacyPausedTask(115, fixture.phase, file);
      legacyTask.provider_sessions = fixture.provider_sessions;
      writeLegacyTasks(repo, [legacyTask]);
      const harness = makeCliHarness(repo, {
        runWorkflow: () => {
          const loaded = loadTasksFile(tasksPath(repo)).tasks[0];
          assert.equal(loaded.state, activeStateForPhase(fixture.phase), file);
          assert.equal(loaded.runtime_phase, fixture.phase, file);
          assert.equal(loaded.runtime.resolved_effort, null, file);
          assert.equal(loaded.runtime.phase_self_correct_done, null, file);
          assert.equal(loaded.runtime.phase_override, null, file);
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
          return [{ ...loaded, state: "merged" }];
        },
      });

      assert.equal(await runCli(["resume", "115"], harness.deps), 0, file);
      assert.doesNotMatch(harness.stderr(), /TaskFileParseError|ConfigParseError/, file);
    }
  });

  it("accepts empty legacy sessions and keeps fresh task sessions schema-compatible", async () => {
    const repo = makeRepo();
    const legacyTask = legacyPausedTask(115, "plan", "empty-sessions");
    legacyTask.provider_sessions = {
      plan: { claude_session_id: null },
      plan_verify: { codex_session_id: null },
      plan_fix: { claude_session_id: null },
      implement: { codex_session_id: null },
      review: null,
      supervise: { claude_session_id: null },
      fix: { codex_session_id: null },
    };
    writeLegacyTasks(repo, [legacyTask]);
    const harness = makeCliHarness(repo, {
      runWorkflow: () => {
        const loaded = loadTasksFile(tasksPath(repo)).tasks[0];
        for (const phase of taskAgentPhases) {
          assert.deepEqual(loaded.provider_sessions[phase], {
            claude_session_id: null,
            codex_session_id: null,
            last_provider: null,
          });
        }
        return [{ ...loaded, state: "merged" }];
      },
    });

    assert.equal(await runCli(["resume", "115"], harness.deps), 0);

    const fresh = createTaskEntry({
      issue: 115,
      slug: "fresh-task",
      title: "fresh task",
      labels: [],
      now: NOW,
    });
    for (const phase of taskAgentPhases) {
      assert.deepEqual(fresh.provider_sessions[phase], {
        claude_session_id: null,
        codex_session_id: null,
        last_provider: null,
      });
    }
    writeLegacyTasks(repo, [fresh as unknown as Record<string, unknown>]);
    const loadedFresh = loadTasksFile(tasksPath(repo)).tasks[0];
    for (const phase of taskAgentPhases) {
      assert.deepEqual(loadedFresh.provider_sessions[phase], {
        claude_session_id: null,
        codex_session_id: null,
        last_provider: null,
      });
    }
  });

  it("parses old config files without effort or phase timeout fields", () => {
    const config = parseConfigYaml(`
version: 1
phases:
  plan:
    provider: claude
  implement:
    provider: codex
`);

    assert.equal(config.effort.default, "medium");
    assert.equal(config.effort.unsupported_policy, "fail");
    assert.equal(config.runner_timeout.implement_ms, undefined);
    assert.equal(resolveRunnerTimeout(config, "implement"), 1_800_000);
    assert.equal(
      resolveRunnerTimeout(config, "implement", {
        phase: "implement",
        provider: "codex",
        effort: "high",
        downgraded_from: null,
        timeout_ms: 3_600_000,
      }),
      3_600_000,
    );
  });
});

function legacyPausedTask(issue: number, phase: AgentPhase, slug: string): Record<string, unknown> {
  const task = parse(
    stringify(
      createTaskEntry({
        issue,
        slug: slug.replace(/\.yaml$/, ""),
        title: slug,
        labels: ["agent-ready"],
        now: NOW,
      }),
    ),
  ) as Record<string, unknown>;
  task.state = "paused";
  task.runtime_phase = phase;
  const runtime = task.runtime as Record<string, unknown>;
  runtime.previous_state = activeStateForPhase(phase);
  delete runtime.resolved_effort;
  delete runtime.phase_self_correct_done;
  delete runtime.phase_override;
  return task;
}

function activeStateForPhase(phase: AgentPhase): TaskEntry["state"] {
  switch (phase) {
    case "plan":
    case "plan_verify":
    case "plan_fix":
      return "planning";
    case "implement":
      return "implementing";
    case "review":
    case "supervise":
      return "reviewing";
    case "fix":
      return "fixing";
  }
}

function parseLegacySessionFixture(source: string): LegacySessionFixture {
  const fixture = parse(source) as Record<string, unknown>;
  const phase = fixture.phase;
  const expectedLastProvider = fixture.expected_last_provider;
  assert.ok(isAgentPhase(phase), "legacy fixture phase must be an agent phase");
  assert.ok(
    expectedLastProvider === "claude" || expectedLastProvider === "codex",
    "legacy fixture expected_last_provider must be claude or codex",
  );
  assert.equal(typeof fixture.provider_sessions, "object");
  assert.notEqual(fixture.provider_sessions, null);

  return {
    phase,
    expected_last_provider: expectedLastProvider,
    provider_sessions: fixture.provider_sessions as LegacySessionFixture["provider_sessions"],
  };
}

function isAgentPhase(value: unknown): value is AgentPhase {
  return typeof value === "string" && taskAgentPhases.includes(value as AgentPhase);
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "autokit-legacy-e2e-"));
  mkdirSync(join(root, ".autokit"), { recursive: true });
  writeFileSync(join(root, ".autokit", ".gitignore"), "*\n!.gitignore\n!config.yaml\n", {
    mode: 0o600,
  });
  writeFileSync(join(root, ".autokit", "config.yaml"), "version: 1\n", { mode: 0o600 });
  writeTasksFileAtomic(tasksPath(root), {
    version: 1,
    generated_at: NOW,
    tasks: [],
  } satisfies WriteTaskInput);
  return root;
}

function writeLegacyTasks(repo: string, tasks: Record<string, unknown>[]): void {
  writeFileSync(
    tasksPath(repo),
    stringify({
      version: 1,
      generated_at: NOW,
      tasks,
    }),
    { mode: 0o600 },
  );
}

function tasksPath(repo: string): string {
  return join(repo, ".autokit", "tasks.yaml");
}

function makeCliHarness(
  cwd: string,
  overrides: Partial<CliDeps> = {},
): { deps: CliDeps; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    deps: {
      cwd,
      env: {},
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
      execFile: () => "",
      now: () => NOW,
      ...overrides,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
