export type GitWorktreeRemoveOptions = {
  force?: boolean;
};

export function buildGitWorktreeRemoveArgs(
  worktreePath: string,
  options: GitWorktreeRemoveOptions = {},
): string[] {
  const args = ["worktree", "remove"];
  if (options.force === true) {
    args.push("--force");
  }
  args.push(worktreePath);
  return args;
}

export function buildGitBranchDeleteArgs(branch: string): string[] {
  return ["branch", "-D", branch];
}

export function buildGitRemoteBranchDeleteArgs(branch: string, remote = "origin"): string[] {
  return ["push", remote, "--delete", branch];
}
