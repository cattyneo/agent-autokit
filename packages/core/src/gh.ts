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
  mergeable: "MERGEABLE" | "BLOCKED" | "UNKNOWN";
};

export function buildGhPrViewArgs(prNumber: number): string[] {
  return ["pr", "view", String(prNumber), "--json", "state,mergedAt,headRefOid,mergeable"];
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
    mergeable: value.mergeable,
  };
}
