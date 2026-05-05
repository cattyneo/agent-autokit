#!/usr/bin/env bash
set -euo pipefail

failures=0

section() {
  printf '\n== %s ==\n' "$1"
}

record_failure() {
  printf 'ERROR: %s\n' "$1" >&2
  failures=$((failures + 1))
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    record_failure "missing required command: $1"
    return
  fi
  printf '%s: %s\n' "$1" "$(command -v "$1")"
}

section "host"
uname -m
if command -v sw_vers >/dev/null 2>&1; then
  sw_vers
fi

section "required commands"
for command_name in node bun gh claude codex; do
  require_cmd "$command_name"
done

section "versions"
node -v
bun -v
gh --version | sed -n '1p'
claude --version
codex --version

section "api key guard"
for env_name in ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY; do
  if [ -n "${!env_name:-}" ]; then
    record_failure "$env_name must be unset for release verification preflight"
  else
    printf '%s=unset\n' "$env_name"
  fi
done

section "github auth"
gh auth status -h github.com

section "fixture permissions"
for repo in \
  cattyneo/agent-autokit-e2e-fixture \
  cattyneo/agent-autokit-e2e-fixture-protected; do
  gh repo view "$repo" \
    --json nameWithOwner,viewerPermission,viewerCanAdminister,defaultBranchRef,isPrivate,mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed
done

section "protected fixture gate"
gh api repos/cattyneo/agent-autokit-e2e-fixture-protected/branches/main/protection \
  --jq '{contexts:.required_status_checks.contexts, reviews:(.required_pull_request_reviews.required_approving_review_count // null), enforce_admins:.enforce_admins.enabled}'
gh pr list --repo cattyneo/agent-autokit-e2e-fixture-protected --state open --json number,title,headRefName

if [ "$failures" -gt 0 ]; then
  exit 1
fi

printf '\nrelease verification environment preflight passed\n'
