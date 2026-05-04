export function shouldPauseForHeadMismatch(
  expectedHeadSha: string | null,
  observedHeadSha: string | null,
): boolean {
  return (
    expectedHeadSha !== null && observedHeadSha !== null && expectedHeadSha !== observedHeadSha
  );
}

export function buildAutoMergeArgs(prNumber: number, headSha: string): string[] {
  return ["pr", "merge", String(prNumber), "--auto", "--rebase", "--match-head-commit", headSha];
}
