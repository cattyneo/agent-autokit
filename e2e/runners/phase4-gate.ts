import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProductionWorkflow, type WorkflowExecFile } from "../../packages/cli/src/executor.ts";
import { codexPromptContractJsonSchema } from "../../packages/codex-runner/src/index.ts";
import {
  type AgentRunInput,
  capabilityPhases,
  createTaskEntry,
  loadTasksFile,
  type Provider,
  promptContractForPhase,
  type RuntimePhase,
  type TaskEntry,
  type TasksFile,
  validatePromptContractPayload,
  writeTasksFileAtomic,
} from "../../packages/core/src/index.ts";
import {
  computeFindingId,
  type ReviewFinding,
  type WorkflowRunner,
} from "../../packages/workflows/src/index.ts";
import {
  runAgentAssetQualityGate,
  runPromptAssetVisibilityGate,
  runSkillAssetQualityGate,
} from "./runner-visibility.ts";

const NOW = "2026-05-08T02:00:00+09:00";
const ISSUE = 110;

export type Phase4CompletionGateResult = {
  assetGateFailures: string[];
  payloadContracts: string[];
  schemaContracts: string[];
  workflowPhases: RuntimePhase[];
  workflowProviders: Provider[];
  workflowPromptContracts: string[];
  selfCorrectionCount: number;
  finalTaskState: TaskEntry["state"];
  commands: string[];
  providerSubprocessCommands: string[];
};

export type Phase4CompletionGateOptions = {
  mutateRepo?: (repo: string) => void;
};

export async function runPhase4CompletionGate(
  options: Phase4CompletionGateOptions = {},
): Promise<Phase4CompletionGateResult> {
  const assetGateFailures = await runAssetGates();
  const payloadContracts = validateAllPromptContractPayloads();
  const schemaContracts = validateCodexSchemas();
  const workflow = await runIntegrationGoldenPath(options);

  return {
    assetGateFailures,
    payloadContracts,
    schemaContracts,
    workflowPhases: workflow.calls.map((call) => call.phase),
    workflowProviders: workflow.calls.map((call) => call.provider),
    workflowPromptContracts: workflow.calls.map((call) => call.promptContract),
    selfCorrectionCount: workflow.selfCorrectionCount,
    finalTaskState: workflow.finalTaskState,
    commands: workflow.commands,
    providerSubprocessCommands: workflow.commands.filter((command) =>
      /^(claude|codex)\b/.test(command),
    ),
  };
}

async function runAssetGates(): Promise<string[]> {
  const prompt = await runPromptAssetVisibilityGate();
  const skills = await runSkillAssetQualityGate();
  const agents = await runAgentAssetQualityGate();
  return [...prompt.failures, ...skills.failures, ...agents.failures];
}

function validateAllPromptContractPayloads(): string[] {
  const contracts = capabilityPhases.map((phase) => promptContractForPhase(phase));
  for (const contract of contracts) {
    const result = validatePromptContractPayload(contract, samplePayload(contract));
    assert.equal(result.ok, true, `${contract}: ${result.ok ? "" : result.errors.join("; ")}`);
  }
  return contracts;
}

function validateCodexSchemas(): string[] {
  const contracts = capabilityPhases.map((phase) => promptContractForPhase(phase));
  const actual = Object.fromEntries(
    contracts.map((contract) => [contract, codexPromptContractJsonSchema(contract)]),
  );
  const snapshot = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../packages/codex-runner/src/fixtures/codex-prompt-contract-schema.snapshot.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ) as unknown;
  assert.deepEqual(actual, snapshot);
  return contracts;
}

async function runIntegrationGoldenPath(options: Phase4CompletionGateOptions): Promise<{
  calls: Array<Pick<AgentRunInput, "phase" | "provider" | "promptContract">>;
  selfCorrectionCount: number;
  finalTaskState: TaskEntry["state"];
  commands: string[];
}> {
  const repo = makeRepo();
  options.mutateRepo?.(repo);
  const commands: string[] = [];
  const calls: Array<Pick<AgentRunInput, "phase" | "provider" | "promptContract">> = [];
  let selfCorrectionCount = 0;

  await runProductionWorkflow({
    cwd: repo,
    env: {},
    execFile: mockExecFile(repo, commands),
    runner: phase4Runner(repo, calls),
    maxSteps: 40,
    now: () => NOW,
    auditOperation: (kind) => {
      if (kind === "phase_self_correct") {
        selfCorrectionCount += 1;
      }
    },
  });

  const finalTask = loadTasksFile(join(repo, ".autokit", "tasks.yaml")).tasks[0];
  assert.ok(finalTask);
  assert.equal(finalTask.state, "merged", finalTask.failure?.message ?? "task did not merge");
  return {
    calls,
    selfCorrectionCount,
    finalTaskState: finalTask.state,
    commands,
  };
}

function phase4Runner(
  repo: string,
  calls: Array<Pick<AgentRunInput, "phase" | "provider" | "promptContract">>,
): WorkflowRunner {
  const finding = reviewFinding();
  const findingId = computeFindingId(finding);
  let planCalls = 0;
  let planVerifyCalls = 0;
  let reviewCalls = 0;

  return async (input) => {
    assertRuntimePrompt(repo, input);
    calls.push({
      phase: input.phase,
      provider: input.provider,
      promptContract: input.promptContract,
    });
    switch (input.phase) {
      case "plan":
        planCalls += 1;
        if (planCalls === 1) {
          throw Object.assign(new Error("phase4 prompt contract drift"), {
            code: "prompt_contract_violation",
          });
        }
        return completed(input.provider, {
          plan_markdown: "## Phase 4 E2E plan\n\nRun prompt, skill, agent, and workflow gates.",
          assumptions: [],
          risks: [],
        });
      case "plan_verify":
        planVerifyCalls += 1;
        if (planVerifyCalls === 1) {
          return completed(input.provider, {
            result: "ng",
            findings: [
              {
                severity: "major",
                title: "Plan must reference Phase 4 integration",
                rationale: "Issue #110 requires a Phase 4 integration golden path.",
                required_change: "Add prompt, skill, agent, schema, and self-correction checks.",
              },
            ],
          });
        }
        return completed(input.provider, { result: "ok", findings: [] });
      case "plan_fix":
        return completed(input.provider, {
          plan_markdown:
            "## Phase 4 E2E plan\n\nAddressed verifier findings and will run all Phase 4 gates.",
          addressed_findings: ["Plan must reference Phase 4 integration"],
        });
      case "implement":
        return completed(input.provider, {
          changed_files: ["e2e/runners/phase4-gate.test.ts"],
          tests_run: [
            {
              command: "bun test e2e/runners/phase4-gate.test.ts",
              result: "passed",
              summary: "Phase 4 gate green",
            },
          ],
          docs_updated: false,
          notes: "Phase 4 gate implemented",
        });
      case "review":
        reviewCalls += 1;
        return completed(input.provider, {
          findings: reviewCalls === 1 ? [finding] : [],
        });
      case "supervise":
        return completed(input.provider, {
          accept_ids: [findingId],
          reject_ids: [],
          reject_reasons: {},
          fix_prompt: "Resolve the Phase 4 review finding.",
        });
      case "fix":
        return completed(input.provider, {
          changed_files: ["e2e/runners/phase4-gate.ts"],
          tests_run: [
            {
              command: "bun test e2e/runners/phase4-gate.test.ts",
              result: "passed",
              summary: "Review fix verified",
            },
          ],
          resolved_accept_ids: [findingId],
          unresolved_accept_ids: [],
          notes: "Review finding resolved",
        });
      default:
        throw new Error(`unexpected phase: ${input.phase}`);
    }
  };
}

function assertRuntimePrompt(repo: string, input: AgentRunInput): void {
  const expectedContract = promptContractForPhase(input.phase);
  assert.equal(input.promptContract, expectedContract, input.phase);
  const promptText = readRuntimePrompt(repo, expectedContract);
  assert.ok(input.prompt.includes(promptText), `${input.phase} prompt asset was not injected`);
}

function readRuntimePrompt(repo: string, contract: string): string {
  const path = join(repo, ".agents", "prompts", `${contract}.md`);
  assert.equal(existsSync(path), true, `${contract} prompt asset exists`);
  return readFileSync(path, "utf8").trim();
}

function samplePayload(contract: string): Record<string, unknown> {
  const finding = reviewFinding();
  const findingId = computeFindingId(finding);
  switch (contract) {
    case "plan":
      return {
        status: "completed",
        summary: "ok",
        data: { plan_markdown: "## Plan", assumptions: [], risks: [] },
      };
    case "plan-verify":
      return { status: "completed", summary: "ok", data: { result: "ok", findings: [] } };
    case "plan-fix":
      return {
        status: "completed",
        summary: "ok",
        data: { plan_markdown: "## Plan", addressed_findings: [] },
      };
    case "implement":
      return {
        status: "completed",
        summary: "ok",
        data: {
          changed_files: ["e2e/runners/phase4-gate.test.ts"],
          tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
          docs_updated: false,
          notes: "implemented",
        },
      };
    case "review":
      return { status: "completed", summary: "ok", data: { findings: [finding] } };
    case "supervise":
      return {
        status: "completed",
        summary: "ok",
        data: {
          accept_ids: [findingId],
          reject_ids: [],
          reject_reasons: {},
          fix_prompt: "Fix it.",
        },
      };
    case "fix":
      return {
        status: "completed",
        summary: "ok",
        data: {
          changed_files: ["e2e/runners/phase4-gate.ts"],
          tests_run: [{ command: "bun test", result: "passed", summary: "ok" }],
          resolved_accept_ids: [findingId],
          unresolved_accept_ids: [],
          notes: "fixed",
        },
      };
    default:
      throw new Error(`unknown contract: ${contract}`);
  }
}

function mockExecFile(repo: string, commands: string[]): WorkflowExecFile {
  const worktree = join(repo, ".autokit", "worktrees", `issue-${ISSUE}`);
  const relativeWorktree = `.autokit/worktrees/issue-${ISSUE}`;
  const revs = [
    "base-head",
    "base-head",
    "agent-head",
    "implement-head",
    "fix-before",
    "rebase-head",
    "agent-fix-head",
    "fix-head",
    "fix-head",
  ];
  let revIndex = 0;
  let lastHead = "base-head";
  let remoteHead = "base-head";
  let prCreated = false;
  let merged = false;

  return (command, args) => {
    const line = `${command} ${args.join(" ")}`;
    commands.push(line);
    if (command === "claude" || command === "codex") {
      throw new Error(`provider subprocess must not run: ${line}`);
    }
    if (line === "git fetch origin main") {
      return "";
    }
    if (command === "git" && args[0] === "worktree" && args[1] === "add") {
      assert.deepEqual(args.slice(0, 4), ["worktree", "add", "-b", `autokit/issue-${ISSUE}`]);
      assert.equal(args[4], worktree);
      assert.equal(args[5], "origin/main");
      mkdirSync(worktree, { recursive: true });
      return "";
    }
    if (line === "git rev-parse HEAD") {
      lastHead = revs[Math.min(revIndex, revs.length - 1)] ?? "fix-head";
      revIndex += 1;
      return lastHead;
    }
    if (line === "git add -A") {
      return "";
    }
    if (line === `git commit -m Implement issue #${ISSUE}`) {
      return "";
    }
    if (line === `git commit -m Fix issue #${ISSUE}`) {
      return "";
    }
    if (line === `git push -u origin autokit/issue-${ISSUE}`) {
      remoteHead = lastHead;
      return "";
    }
    if (line === "git rebase origin/main") {
      return "";
    }
    if (line === `git push origin --delete autokit/issue-${ISSUE}`) {
      return "";
    }
    if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
      assert.equal(args[2], relativeWorktree);
      rmSync(worktree, { recursive: true, force: true });
      return "";
    }
    if (line === "git worktree prune") {
      return "";
    }
    if (line === `gh issue view ${ISSUE} --json number,title,body,labels,state,url`) {
      return JSON.stringify({
        number: ISSUE,
        title: "[v0.2 P4-E2E] Phase 4 E2E gate",
        body: "Phase 4 completion gate fixture",
        labels: [{ name: "agent-ready" }, { name: "type:test" }],
        state: "OPEN",
        url: `https://github.com/cattyneo/agent-autokit/issues/${ISSUE}`,
      });
    }
    if (
      line ===
      `gh pr list --head autokit/issue-${ISSUE} --state all --json number,state,headRefOid,baseRefOid --limit 1`
    ) {
      return prCreated
        ? JSON.stringify([
            { number: ISSUE, state: "OPEN", headRefOid: remoteHead, baseRefOid: "base-head" },
          ])
        : "[]";
    }
    if (line.startsWith("gh pr create --draft")) {
      prCreated = true;
      return `https://github.com/cattyneo/agent-autokit/pull/${ISSUE}`;
    }
    if (line === `gh pr view ${ISSUE} --json headRefOid,baseRefOid`) {
      return JSON.stringify({ headRefOid: remoteHead, baseRefOid: "base-head" });
    }
    if (line === `gh pr ready ${ISSUE}`) {
      return "";
    }
    if (line === `gh pr view ${ISSUE} --json statusCheckRollup`) {
      return JSON.stringify({
        statusCheckRollup: [
          {
            name: "phase4-e2e",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            detailsUrl: "https://github.com/cattyneo/agent-autokit/actions/runs/110",
          },
        ],
      });
    }
    if (
      line === `gh pr view ${ISSUE} --json headRefOid,mergeable,mergeStateStatus,autoMergeRequest`
    ) {
      return JSON.stringify({
        headRefOid: remoteHead,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        autoMergeRequest: null,
      });
    }
    if (line === `gh pr merge ${ISSUE} --auto --rebase --match-head-commit ${remoteHead}`) {
      merged = true;
      return "";
    }
    if (
      line === `gh pr view ${ISSUE} --json state,mergedAt,headRefOid,mergeable,mergeStateStatus`
    ) {
      return JSON.stringify({
        state: merged ? "MERGED" : "OPEN",
        mergedAt: merged ? "2026-05-07T17:00:00Z" : null,
        headRefOid: remoteHead,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      });
    }
    throw new Error(`unexpected exec: ${line}`);
  };
}

function completed(provider: Provider, structured: Record<string, unknown>) {
  return {
    status: "completed" as const,
    summary: "ok",
    structured,
    session:
      provider === "claude"
        ? { claudeSessionId: `claude-phase4-${structuredSummary(structured)}` }
        : { codexSessionId: `codex-phase4-${structuredSummary(structured)}` },
  };
}

function structuredSummary(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join("-").slice(0, 32) || "empty";
}

function reviewFinding(): ReviewFinding {
  return {
    severity: "P2",
    file: "e2e/runners/phase4-gate.ts",
    line: 1,
    title: "Phase 4 gate requires review fix",
    rationale: "The integration path should exercise supervise and fix before merge.",
    suggested_fix: "Accept the finding and run the fix phase.",
  };
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "autokit-phase4-gate-"));
  mkdirSync(join(repo, ".autokit"), { recursive: true });
  writeFileSync(join(repo, ".autokit", "audit-hmac-key"), "phase4-fixture-hmac-key", {
    mode: 0o600,
  });
  writeFileSync(
    join(repo, ".autokit", "config.yaml"),
    [
      "version: 1",
      "base_branch: main",
      "ci:",
      "  poll_interval_ms: 1",
      "  timeout_ms: 1000",
      "merge:",
      "  poll_interval_ms: 1",
      "  timeout_ms: 1000",
      "  branch_delete_grace_ms: 1",
    ].join("\n"),
    { mode: 0o600 },
  );
  cpSync(
    fileURLToPath(new URL("../../packages/cli/assets/", import.meta.url)),
    join(repo, ".agents"),
    {
      recursive: true,
    },
  );
  writeTasks(repo, [
    createTaskEntry({
      issue: ISSUE,
      slug: "phase4-e2e-gate",
      title: "[v0.2 P4-E2E] Phase 4 E2E gate",
      labels: ["agent-ready", "type:test", "phase:p4"],
      now: NOW,
    }),
  ]);
  assert.equal(existsSync(join(repo, ".agents", "prompts", "plan.md")), true);
  return repo;
}

function writeTasks(root: string, tasks: TaskEntry[]): void {
  const tasksFile: TasksFile = { version: 1, generated_at: NOW, tasks };
  writeTasksFileAtomic(join(root, ".autokit", "tasks.yaml"), tasksFile);
}
