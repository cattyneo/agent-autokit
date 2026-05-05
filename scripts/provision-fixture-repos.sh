#!/usr/bin/env bash
set -euo pipefail

OWNER="${AUTOKIT_FIXTURE_OWNER:-cattyneo}"
UNPROTECTED_REPO="${AUTOKIT_FIXTURE_REPO:-agent-autokit-e2e-fixture}"
PROTECTED_REPO="${AUTOKIT_PROTECTED_FIXTURE_REPO:-agent-autokit-e2e-fixture-protected}"
VISIBILITY="${AUTOKIT_FIXTURE_VISIBILITY:-private}"
WORKDIR="${AUTOKIT_FIXTURE_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/autokit-fixture-provision.XXXXXX")}"
ALLOW_NONSTANDARD_TARGETS="${AUTOKIT_FIXTURE_ALLOW_NONSTANDARD_TARGETS:-0}"

DEFAULT_OWNER="cattyneo"
DEFAULT_UNPROTECTED_REPO="agent-autokit-e2e-fixture"
DEFAULT_PROTECTED_REPO="agent-autokit-e2e-fixture-protected"

if [ "$VISIBILITY" != "private" ] && [ "$VISIBILITY" != "public" ]; then
  echo "AUTOKIT_FIXTURE_VISIBILITY must be private or public" >&2
  exit 2
fi

if {
  [ "$OWNER" != "$DEFAULT_OWNER" ] ||
    [ "$UNPROTECTED_REPO" != "$DEFAULT_UNPROTECTED_REPO" ] ||
    [ "$PROTECTED_REPO" != "$DEFAULT_PROTECTED_REPO" ];
} && [ "$ALLOW_NONSTANDARD_TARGETS" != "1" ]; then
  echo "nonstandard fixture targets require AUTOKIT_FIXTURE_ALLOW_NONSTANDARD_TARGETS=1" >&2
  exit 2
fi

require_clean_env() {
  local leaked=()
  for name in ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY; do
    if [ -n "${!name:-}" ]; then
      leaked+=("$name")
    fi
  done
  if [ "${#leaked[@]}" -gt 0 ]; then
    printf 'API key env must be unset: %s\n' "${leaked[*]}" >&2
    exit 2
  fi
}

ensure_repo() {
  local repo="$1"
  if gh repo view "$OWNER/$repo" >/dev/null 2>&1; then
    return
  fi
  if [ "$VISIBILITY" = "private" ]; then
    gh repo create "$OWNER/$repo" --private --disable-wiki --description "agent-autokit v0.1 e2e fixture"
  else
    gh repo create "$OWNER/$repo" --public --disable-wiki --description "agent-autokit v0.1 e2e fixture"
  fi
}

write_fixture_files() {
  local dir="$1"
  rm -rf "$dir/.github" "$dir/.autokit" "$dir/src" "$dir/package.json" "$dir/README.md" "$dir/vitest.config.ts"
  mkdir -p "$dir/.github/workflows" "$dir/.autokit" "$dir/src"
  cat >"$dir/package.json" <<'JSON'
{
  "name": "agent-autokit-e2e-fixture",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.3.13",
  "scripts": {
    "test": "bun test",
    "vitest": "vitest run"
  },
  "devDependencies": {
    "bun-types": "^1.3.13",
    "vitest": "^4.0.8"
  }
}
JSON
  cat >"$dir/.github/workflows/ci.yml" <<'YAML'
name: CI

on:
  pull_request:
  push:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.13
      - run: bun install --frozen-lockfile
      - run: bun test
YAML
  cat >"$dir/.autokit/config.yaml" <<'YAML'
version: 1
parallel: 1
base_branch: ""
branch_prefix: autokit/
auto_merge: true
review:
  max_rounds: 3
  warn_threshold: 2
plan:
  max_rounds: 4
ci:
  poll_interval_ms: 10000
  timeout_ms: 1800000
  timeout_action: paused
  fix_max_rounds: 3
merge:
  poll_interval_ms: 5000
  timeout_ms: 1800000
  branch_delete_grace_ms: 5000
  worktree_remove_retry_max: 3
label_filter: []
runtime:
  max_untrusted_input_kb: 256
phases:
  plan:
    provider: claude
    model: auto
    prompt_contract: plan
  plan_verify:
    provider: codex
    model: auto
    prompt_contract: plan-verify
  plan_fix:
    provider: claude
    model: auto
    prompt_contract: plan-fix
  implement:
    provider: codex
    model: auto
    prompt_contract: implement
  review:
    provider: claude
    model: auto
    prompt_contract: review
  supervise:
    provider: claude
    model: auto
    prompt_contract: supervise
  fix:
    provider: codex
    model: auto
    prompt_contract: fix
permissions:
  claude:
    auto_mode: optional
    workspace_scope: worktree
    allowed_tools:
      - Read
      - Grep
      - Glob
    home_isolation: shared
  codex:
    sandbox_mode: workspace-write
    approval_policy: on-request
    allow_network: false
    home_isolation: shared
runner_timeout:
  plan_ms: 600000
  implement_ms: 1800000
  review_ms: 600000
  default_ms: 600000
  default_idle_ms: 300000
logging:
  level: info
  retention_days: 30
  max_file_size_mb: 100
  max_total_size_mb: 1024
  redact_patterns:
    - ghp_[A-Za-z0-9]{20,}
    - sk-[A-Za-z0-9]{20,}
init:
  backup_dir: .autokit/.backup
  backup_mode: "0700"
  backup_blacklist:
    - .claude/credentials*
    - .claude/state
    - .claude/sessions
    - .codex/auth*
    - .codex/credentials*
    - .autokit/audit-hmac-key
YAML
  cat >"$dir/vitest.config.ts" <<'TS'
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"]
  }
});
TS
  cat >"$dir/src/pagination.ts" <<'TS'
export type PageWindow = {
  page: number;
  pageSize: number;
  start: number;
  end: number;
};

export function paginationWindow(page: number, pageSize: number, totalItems: number): PageWindow {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError("page must be a positive integer");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError("pageSize must be a positive integer");
  }
  if (!Number.isInteger(totalItems) || totalItems < 0) {
    throw new RangeError("totalItems must be a non-negative integer");
  }
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, totalItems);
  return { page, pageSize, start, end };
}
TS
  cat >"$dir/src/pagination.test.ts" <<'TS'
import { expect, test } from "bun:test";

import { paginationWindow } from "./pagination.ts";

test("calculates the first page window", () => {
  expect(paginationWindow(1, 10, 35)).toEqual({
    page: 1,
    pageSize: 10,
    start: 0,
    end: 10
  });
});

test("clamps the final page window to total items", () => {
  expect(paginationWindow(4, 10, 35)).toEqual({
    page: 4,
    pageSize: 10,
    start: 30,
    end: 35
  });
});
TS
  cat >"$dir/README.md" <<'MD'
# agent-autokit e2e fixture

Minimal TypeScript/Bun repository for agent-autokit v0.1 integration smoke.
MD
}

push_fixture() {
  local repo="$1"
  local dir="$WORKDIR/$repo"
  rm -rf "$dir"
  if gh api "repos/$OWNER/$repo/branches/main" >/dev/null 2>&1; then
    git clone --depth 1 "https://github.com/$OWNER/$repo.git" "$dir" >/dev/null
    rm -rf "$dir/.github" "$dir/.autokit" "$dir/src" "$dir/package.json" "$dir/README.md" "$dir/vitest.config.ts"
  else
    mkdir -p "$dir"
    git -C "$dir" init -b main >/dev/null
    git -C "$dir" remote add origin "https://github.com/$OWNER/$repo.git"
  fi
  write_fixture_files "$dir"
  git -C "$dir" add .
  if git -C "$dir" diff --cached --quiet; then
    return
  fi
  git -C "$dir" -c core.hooksPath=/dev/null -c user.name="autokit provisioning" -c user.email="autokit@example.invalid" commit -m "Provision autokit fixture" >/dev/null
  git -C "$dir" -c core.hooksPath=/dev/null push -u origin main
}

ensure_label() {
  local repo="$1"
  local label="$2"
  local color="$3"
  if gh label list --repo "$OWNER/$repo" --json name --jq '.[].name' | grep -Fx "$label" >/dev/null; then
    return
  fi
  gh label create "$label" --repo "$OWNER/$repo" --color "$color"
}

ensure_issue() {
  local repo="$1"
  ensure_label "$repo" bug d73a4a
  ensure_label "$repo" agent-ready 5319e7
  local existing
  existing="$(gh issue list --repo "$OWNER/$repo" --state open --search 'Fix: off-by-one in pagination calc in:title' --json number --jq '.[0].number // empty')"
  if [ -n "$existing" ]; then
    echo "$existing"
    return
  fi
  local created_url
  created_url="$(gh issue create \
    --repo "$OWNER/$repo" \
    --title "Fix: off-by-one in pagination calc" \
    --label bug \
    --label agent-ready \
    --body-file - <<'MD'
## Expected behavior

`paginationWindow(page, pageSize, totalItems)` should return a zero-based half-open window:

- `start` is inclusive.
- `end` is exclusive.
- A page beyond the final item clamps both `start` and `end` to `totalItems`.

## Current gap

The existing tests cover the first and final populated pages, but not an empty page after the end of the collection.

## Reproduction test to add

```ts
test("clamps an empty page after the final item", () => {
  expect(paginationWindow(5, 10, 35)).toEqual({
    page: 5,
    pageSize: 10,
    start: 35,
    end: 35
  });
});
```

## Acceptance criteria

- Add the failing test above.
- Fix `paginationWindow` so the new test and existing tests pass.
- Keep the implementation in `src/pagination.ts`.
MD
)"
  basename "$created_url"
}

protect_main() {
  local repo="$1"
  gh repo edit "$OWNER/$repo" --enable-auto-merge
  local body
  body="$(mktemp)"
  cat >"$body" <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["test"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false
}
JSON
  gh api -X PUT "repos/$OWNER/$repo/branches/main/protection" --input "$body" >/dev/null
}

ensure_unprotected_main() {
  local repo="$1"
  if gh api "repos/$OWNER/$repo/branches/main/protection" >/dev/null 2>&1; then
    gh api -X DELETE "repos/$OWNER/$repo/branches/main/protection" >/dev/null
  fi
  if gh api "repos/$OWNER/$repo/branches/main/protection" >/dev/null 2>&1; then
    echo "$OWNER/$repo main must remain unprotected" >&2
    exit 2
  fi
}

require_clean_env
mkdir -p "$WORKDIR"
ensure_repo "$UNPROTECTED_REPO"
ensure_repo "$PROTECTED_REPO"
push_fixture "$UNPROTECTED_REPO"
push_fixture "$PROTECTED_REPO"
ensure_unprotected_main "$UNPROTECTED_REPO"
issue_number="$(ensure_issue "$UNPROTECTED_REPO")"
protect_main "$PROTECTED_REPO"

cat <<EOF
owner=$OWNER
unprotected_repo=$OWNER/$UNPROTECTED_REPO
protected_repo=$OWNER/$PROTECTED_REPO
fixture_issue=$issue_number
workdir=$WORKDIR
EOF
