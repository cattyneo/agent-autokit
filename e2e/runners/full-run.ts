import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildGhEnv } from "../../packages/core/src/env-allowlist.ts";
import { loadTasksFile, parseConfigYaml, type TaskEntry } from "../../packages/core/src/index.ts";

export type ObsId =
  | "OBS-01"
  | "OBS-02"
  | "OBS-03"
  | "OBS-04"
  | "OBS-05"
  | "OBS-06"
  | "OBS-07"
  | "OBS-08"
  | "OBS-09"
  | "OBS-10"
  | "OBS-11";

export type Observation = {
  id: ObsId;
  label: string;
  passed: boolean;
  evidence: string;
};

export type VerifyUnprotectedSmokeInput = {
  repoPath: string;
  ownerRepo: string;
  issue: number;
  runExitCode: number;
  prNumber?: number;
  gh?: GhJsonRunner;
};

export type VerifyUnprotectedSmokeResult = {
  ok: boolean;
  observations: Observation[];
  task: {
    issue: number;
    state: string;
    prNumber: number | null;
    reviewRound: number;
    ciFixRound: number;
  };
};

export type GhJsonRunner = (args: string[]) => GhJsonResult;

type GhJsonResult = {
  ok: boolean;
  stdout?: unknown;
  stderr?: string;
  status?: number;
};

type PullRequestView = {
  state?: string;
  mergedAt?: string | null;
  headRefOid?: string | null;
};

const FAILURE_HISTORY_KINDS = new Set([
  "rate_limited",
  "ci_failure_max",
  "merge_sha_mismatch",
  "manual_merge_required",
  "branch_protection",
  "ci_timeout",
  "merge_timeout",
  "other",
]);

export function verifyUnprotectedSmoke(
  input: VerifyUnprotectedSmokeInput,
): VerifyUnprotectedSmokeResult {
  const tasksFile = loadTasksFile(join(input.repoPath, ".autokit", "tasks.yaml"));
  const task = tasksFile.tasks.find((entry) => entry.issue === input.issue);
  if (!task) {
    throw new Error(`issue ${input.issue} is not present in tasks.yaml`);
  }

  const config = parseConfigYaml(
    readFileSync(join(input.repoPath, ".autokit", "config.yaml"), "utf8"),
  );
  const prNumber = input.prNumber ?? task.pr.number;
  const logs = readAuditLogs(input.repoPath);
  const gh = input.gh ?? runGhJson;
  const prView = prNumber
    ? gh([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        input.ownerRepo,
        "--json",
        "state,mergedAt,headRefOid",
      ])
    : { ok: false, stderr: "missing PR number" };
  const branchView = task.branch
    ? gh(["api", `repos/${input.ownerRepo}/branches/${task.branch}`])
    : { ok: false, stderr: "missing branch name" };

  const observations: Observation[] = [
    {
      id: "OBS-01",
      label: "autokit run exit code",
      passed: input.runExitCode === 0,
      evidence: String(input.runExitCode),
    },
    {
      id: "OBS-02",
      label: "final task state",
      passed: task.state === "merged",
      evidence: task.state,
    },
    {
      id: "OBS-03",
      label: "GitHub PR state",
      passed: isMergedPr(prView),
      evidence: JSON.stringify(prView.stdout ?? prView.stderr ?? null),
    },
    {
      id: "OBS-04",
      label: "review rounds within max and no final accepted findings",
      passed: task.review_round <= config.review.max_rounds && lastReviewAcceptCount(task) === 0,
      evidence: `review_round=${task.review_round}, max=${config.review.max_rounds}, last_accept_count=${lastReviewAcceptCount(
        task,
      )}`,
    },
    {
      id: "OBS-05",
      label: "CI fix round",
      passed: task.ci_fix_round === 0,
      evidence: String(task.ci_fix_round),
    },
    {
      id: "OBS-06",
      label: "required audit kinds",
      passed:
        countAuditKind(logs, "auto_merge_reserved") >= 1 &&
        countAuditKind(logs, "branch_deleted") >= 1,
      evidence: `auto_merge_reserved=${countAuditKind(logs, "auto_merge_reserved")}, branch_deleted=${countAuditKind(
        logs,
        "branch_deleted",
      )}`,
    },
    {
      id: "OBS-07",
      label: "forbidden failure audit kinds",
      passed: forbiddenAuditKinds(logs).length === 0,
      evidence: forbiddenAuditKinds(logs).join(",") || "none",
    },
    {
      id: "OBS-08",
      label: "review file",
      passed: existsSync(
        join(input.repoPath, ".autokit", "reviews", `issue-${input.issue}-review-1.md`),
      ),
      evidence: `.autokit/reviews/issue-${input.issue}-review-1.md`,
    },
    {
      id: "OBS-09",
      label: "sanitize HMAC audit",
      passed: logs.some((entry) => typeof entry.sanitize_hmac === "string"),
      evidence: `sanitize_hmac_count=${logs.filter((entry) => typeof entry.sanitize_hmac === "string").length}`,
    },
    {
      id: "OBS-10",
      label: "remote branch deleted",
      passed: !branchView.ok && branchView.status === 1,
      evidence: branchView.stderr ?? JSON.stringify(branchView.stdout ?? null),
    },
    {
      id: "OBS-11",
      label: "local worktree removed",
      passed: task.worktree_path !== null && !existsSync(join(input.repoPath, task.worktree_path)),
      evidence: String(task.worktree_path),
    },
  ];

  return {
    ok: observations.every((observation) => observation.passed),
    observations,
    task: {
      issue: task.issue,
      state: task.state,
      prNumber,
      reviewRound: task.review_round,
      ciFixRound: task.ci_fix_round,
    },
  };
}

function readAuditLogs(repoPath: string): Array<Record<string, unknown>> {
  const logsDir = join(repoPath, ".autokit", "logs");
  if (!existsSync(logsDir)) {
    return [];
  }
  return readdirSync(logsDir)
    .filter((file) => file.endsWith(".log"))
    .flatMap((file) =>
      readFileSync(join(logsDir, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
}

function isMergedPr(result: GhJsonResult): boolean {
  if (!result.ok || result.stdout === null || typeof result.stdout !== "object") {
    return false;
  }
  const view = result.stdout as PullRequestView;
  return view.state === "MERGED" || view.mergedAt != null;
}

function lastReviewAcceptCount(task: TaskEntry): number {
  const last = task.review_findings.at(-1);
  return last?.accept_ids.length ?? 0;
}

function countAuditKind(logs: Array<Record<string, unknown>>, kind: string): number {
  return logs.filter((entry) => entry.kind === kind).length;
}

function forbiddenAuditKinds(logs: Array<Record<string, unknown>>): string[] {
  return logs
    .map((entry) => entry.kind)
    .filter((kind): kind is string => typeof kind === "string" && FAILURE_HISTORY_KINDS.has(kind));
}

function runGhJson(args: string[]): GhJsonResult {
  const result = spawnSync("gh", args, { encoding: "utf8", env: buildGhEnv(process.env) });
  if (result.status !== 0) {
    return {
      ok: false,
      stderr: result.stderr.trim(),
      status: result.status ?? 1,
    };
  }
  return {
    ok: true,
    stdout: result.stdout.trim() ? (JSON.parse(result.stdout) as unknown) : null,
    status: 0,
  };
}

function parseCliArgs(argv: string[]): VerifyUnprotectedSmokeInput & { json: boolean } {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      values.set(arg, value);
      index += 1;
    }
  }

  const repoPath = values.get("--repo");
  const ownerRepo = values.get("--owner-repo");
  const issue = Number(values.get("--issue"));
  const runExitCode = Number(values.get("--run-exit-code"));
  const prValue = values.get("--pr");
  if (!repoPath || !ownerRepo || !Number.isInteger(issue) || !Number.isInteger(runExitCode)) {
    throw new Error(
      "Usage: bun e2e/runners/full-run.ts --repo <path> --owner-repo <owner/repo> --issue <n> --run-exit-code <code> [--pr <n>] [--json]",
    );
  }

  return {
    repoPath,
    ownerRepo,
    issue,
    runExitCode,
    prNumber: prValue ? Number(prValue) : undefined,
    json,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { json, ...input } = parseCliArgs(process.argv.slice(2));
    const result = verifyUnprotectedSmoke(input);
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      for (const observation of result.observations) {
        process.stdout.write(
          `${observation.passed ? "PASS" : "FAIL"}\t${observation.id}\t${observation.label}\t${observation.evidence}\n`,
        );
      }
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
