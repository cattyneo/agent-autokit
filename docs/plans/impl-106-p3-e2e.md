# Issue #106 Implementation Plan: Phase 3 E2E gate

## Goal

Add the required Phase 3 E2E gate proving preset list/show/apply, external backup, atomic rename, rollback, redaction, lock exclusion, and fake-run completion across the bundled presets without invoking live providers or real GitHub operations.

## Context

- Issue: #106 `[v0.2 P3-E2E] Phase 3 E2E gate`
- Dependencies: #103, #104, and #105 are closed.
- Worktree/branch: `.agents/worktrees/issue-106-p3-e2e` / `codex/issue-106-p3-e2e`
- SSOT:
  - `docs/spec/phase3-preset.md` §2.1, §3.1, §3.2, §3.3, §4
  - `docs/references/v0.2.0-issue-plan.md` Issue P3-E2E
  - `docs/SPEC.md` and `docs/PLAN.md` as frozen v0.1 references

## Scope

- Add a Phase 3 gate under `e2e/runners/` using fake workflow seams and local fixture repos.
- Cover the integration golden path: `init` -> bundled `preset apply default` -> repo-external backup -> atomic `.agents` replacement -> `doctor` -> fake `run`.
- Cover initial presets (`laravel-filament`, `next-shadcn`, `docs-create`) through apply, doctor, and fake run.
- Cover fail-closed fixtures for blacklist/path traversal, existing `.agents` credential preflight, redacted stderr/audit details, rollback success/failure after post-rename doctor failure, and lock exclusion.
- Reuse the existing prompt-contract and assets hygiene gates rather than duplicating their full assertions.

## Non-Scope

- No live Claude/Codex subprocess or API-key-backed provider run.
- No real `gh` command execution.
- No new preset command surface such as dry-run/export.
- No prompt, skill, or bundled preset content changes unless the new gate exposes an actual #106 blocker.
- No new failure code or audit kind beyond asserting the kinds already specified and implemented by #103/#104.

## Acceptance Criteria

- Required E2E uses fake runner/fakeGh seams only.
- `preset list / show / apply` and `doctor` pass after apply.
- API/CLI write lock behavior keeps `.agents` and `tasks.yaml` unchanged on contention.
- Backup is outside the repo and can reproduce the pre-apply `.agents` manifest.
- Rename-after-doctor failure rolls back `.agents` on restore success, emits rollback failure evidence on restore failure, and exits non-zero with public stderr.
- Blacklist/path traversal failures are fail-closed and redacted to category-only output.
- Initial Laravel/Next/docs-create presets pass fixture E2E.
- Prompt contract and asset hygiene remain covered by the existing required gates.

## Test Scenarios

- RED: new `phase3-gate.test.ts` expects a full apply->doctor->run golden path and initially fails if any contract is missing.
- RED: rollback, redaction, and lock fixtures assert existing edge cases at Phase 3 gate level.
- GREEN: adjust only the minimal owning code if the gate exposes a contract gap.
- Regression: run focused Phase 3 gate, prompt-contract gates, CLI preset tests, then common required gates.

## Implementation Steps

1. Add `e2e/runners/phase3-gate.test.ts` with local helpers matching the existing phase gate style.
2. Implement the golden path fixture for `default` with external backup manifest verification and fake run completion.
3. Add the initial preset matrix fixture for `laravel-filament`, `next-shadcn`, and `docs-create`.
4. Add failure fixtures for blacklist redaction/path traversal, existing `.agents` credential preflight, rollback success/failure after post-apply doctor failure, and write-lock exclusion.
5. Run focused tests, fix any contract gaps, then run required gates.

## Validation Plan

- `npx --yes bun@1.3.13 test e2e/runners/phase3-gate.test.ts`
- `npx --yes bun@1.3.13 test packages/cli/src/index.test.ts e2e/runners/runner-visibility.test.ts packages/codex-runner/src/index.test.ts packages/core/src/runner-contract.test.ts`
- `npx --yes bun@1.3.13 run lint`
- `npx --yes bun@1.3.13 run typecheck`
- `npx --yes bun@1.3.13 test`
- `npx --yes bun@1.3.13 run build`
- `/bin/bash scripts/check-assets-hygiene.sh`
- `bash scripts/check-trace.sh` because this gate asserts `failure.code` and preset audit kind coverage.
