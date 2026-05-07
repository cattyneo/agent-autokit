export type GhPrView = {
  state: "OPEN" | "MERGED" | "CLOSED";
  merged: boolean;
  headRefOid: string | null;
  mergeable: "MERGEABLE" | "BLOCKED" | "UNKNOWN";
};

export type GhPrViewJson = {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
  headRefOid: string | null;
  mergeable?: unknown;
  mergeStateStatus?: unknown;
};

export function buildGhPrViewArgs(prNumber: number): string[] {
  return [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "state,mergedAt,headRefOid,mergeable,mergeStateStatus",
  ];
}

export function buildGhPrViewHeadArgs(prNumber: number): string[] {
  return ["pr", "view", String(prNumber), "--json", "headRefOid,baseRefOid"];
}

export function buildGhPrViewCiArgs(prNumber: number): string[] {
  return ["pr", "view", String(prNumber), "--json", "statusCheckRollup"];
}

export function buildGhRunViewFailedLogArgs(runId: string): string[] {
  return ["run", "view", runId, "--log-failed"];
}

export function buildGhPrViewMergeArgs(prNumber: number): string[] {
  return [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "headRefOid,mergeable,mergeStateStatus,autoMergeRequest",
  ];
}

export function buildGhPrListHeadArgs(branch: string): string[] {
  return [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number,state,headRefOid,baseRefOid",
    "--limit",
    "1",
  ];
}

export function buildGhPrCreateDraftArgs(input: {
  title: string;
  body: string;
  head: string;
  base: string;
}): string[] {
  return [
    "pr",
    "create",
    "--draft",
    "--title",
    input.title,
    "--body",
    input.body,
    "--head",
    input.head,
    "--base",
    input.base,
  ];
}

export function buildGhPrReadyArgs(prNumber: number): string[] {
  return ["pr", "ready", String(prNumber)];
}

export function buildGhIssueViewBodyArgs(issue: number): string[] {
  return ["issue", "view", String(issue), "--json", "number,title,body,labels,state,url"];
}

export function buildGhPrCloseArgs(prNumber: number): string[] {
  return [
    "pr",
    "close",
    String(prNumber),
    "--delete-branch",
    "--comment",
    "autokit retry: superseded",
  ];
}

export function parseGhPrView(value: GhPrViewJson): GhPrView {
  return {
    state: value.state,
    merged: value.state === "MERGED" || value.mergedAt !== null,
    headRefOid: value.headRefOid,
    mergeable: parseGhMergeability(value),
  };
}

export function parseGhMergeability(value: {
  mergeable?: unknown;
  mergeStateStatus?: unknown;
}): "MERGEABLE" | "BLOCKED" | "UNKNOWN" {
  if (value.mergeStateStatus === "BLOCKED" || value.mergeable === "BLOCKED") {
    return "BLOCKED";
  }
  if (value.mergeable === "MERGEABLE") {
    return "MERGEABLE";
  }
  if (value.mergeStateStatus === "CLEAN" || value.mergeStateStatus === "HAS_HOOKS") {
    return "MERGEABLE";
  }
  return "UNKNOWN";
}
