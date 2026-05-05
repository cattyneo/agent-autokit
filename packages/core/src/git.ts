export type GitWorktreeRemoveOptions = {
  force?: boolean;
};

export function buildGitWorktreeAddArgs(input: {
  worktreePath: string;
  branch: string;
  baseRef: string;
}): string[] {
  return ["worktree", "add", "-b", input.branch, input.worktreePath, input.baseRef];
}

export function buildGitWorktreeAddExistingBranchArgs(input: {
  worktreePath: string;
  branch: string;
}): string[] {
  return ["worktree", "add", input.worktreePath, input.branch];
}

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

export function buildGitRevParseHeadArgs(): string[] {
  return ["rev-parse", "HEAD"];
}

export function buildGitFetchArgs(remote: string, ref: string): string[] {
  return ["fetch", remote, ref];
}

export function buildGitAddAllArgs(): string[] {
  return ["add", "-A"];
}

export function buildGitCommitArgs(message: string): string[] {
  return ["commit", "-m", message];
}

export function buildGitPushSetUpstreamArgs(branch: string, remote = "origin"): string[] {
  return ["push", "-u", remote, branch];
}

export function buildGitRebaseArgs(baseRef: string): string[] {
  return ["rebase", baseRef];
}

export function buildGitWorktreePruneArgs(): string[] {
  return ["worktree", "prune"];
}
