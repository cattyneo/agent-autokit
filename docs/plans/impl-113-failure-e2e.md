# Implementation Plan: Issue #113 failure E2E

## Goal

Add an active Phase E.2 E2E gate that proves representative v0.2 failure scenarios obey the stateful vs non-stateful contracts without live providers.

## Observable success criteria

- [x] `e2e/runners/failure-codes.test.ts` covers the honest matrix: stateful 5 codes x 4 routes plus non-stateful 3 codes x 1 route.
- [x] Stateful codes covered: `review_max`, `ci_failure_max`, `prompt_contract_violation`, `phase_attempt_exceeded`, `effort_unsupported`.
- [x] Non-stateful codes covered: `preset_path_traversal`, `preset_blacklist_hit`, `lock_host_mismatch`.
- [x] Stateful fixtures assert `tasks.yaml.failure.code`, CLI/workflow exit semantics, resume rejection for failed tasks, retry cleanup including worktree removal, and `cleanup --force-detach` rejection for non-candidates.
- [x] Non-stateful fixtures assert `tasks.yaml` task entry absence or unchanged queue, exit 1, audit-only evidence, and no resume/retry/cleanup target.
- [ ] The required E2E is in normal `bun test` discovery and `rg "test\.todo|describe\.skip" e2e packages` has no matches.

## Key constraints

- Scope is abnormal/failure scenario E2E only; security redaction breadth belongs to #114 and full trace-set exactness belongs to #117.
- Required E2E must use fake runners/fake GitHub or direct workflow seams; no live Claude/Codex/provider calls.
- Do not add new `failure.code` or audit kind in this PR. If a missing code/kind is discovered, stop and report scope drift.
- Keep helper code local to `failure-codes.test.ts` unless another E.* issue clearly needs extraction.

## Source of truth

- Live Issue #113.
- `docs/references/v0.2.0-issue-plan.md` Issue E.2 and Phase E harness policy.
- `docs/spec/cross-cutting.md` §1, §1.1, §2.
- `docs/SPEC.md` §4.2.1.1, §5.1, §5.2, §6.2, §7.6.4, §7.6.5.
- Existing harnesses: `e2e/runners/review-fix-loop.test.ts`, `e2e/runners/ci-fix-loop.test.ts`, `e2e/runners/phase2a-gate.test.ts`, `e2e/runners/phase3-gate.test.ts`, `packages/cli/src/executor.test.ts`.

## Execution steps

- [x] Build a local matrix table with 5 stateful and 3 non-stateful cases.
- [x] Reuse direct workflow seams for stateful codes where they already expose deterministic failure generation.
- [x] Add CLI-level checks for retry/resume/cleanup routes using temp repos and fake `execFile`; failed stateful tasks cover retry worktree removal and cleanup non-candidate rejection.
- [x] Add preset abort fixtures for `preset_path_traversal` and `preset_blacklist_hit` that prove no task entry is written.
- [x] Add a `lock_host_mismatch` CLI fixture using stale/foreign holder metadata and force-unlock recovery.
- [x] Assert no live provider subprocess command is invoked in required E2E.
- [ ] Run RED, implement, then focused and common gates.

## Initial RED

- `npx --yes bun@1.3.13 test e2e/runners/failure-codes.test.ts` should fail before the file exists.

## Verification plan

- Focused:
  - `npx --yes bun@1.3.13 test e2e/runners/failure-codes.test.ts`
  - `npx --yes bun@1.3.13 test e2e/runners/failure-codes.test.ts e2e/runners/review-fix-loop.test.ts e2e/runners/ci-fix-loop.test.ts e2e/runners/phase3-gate.test.ts e2e/runners/phase2a-gate.test.ts packages/cli/src/executor.test.ts`
- Required:
  - `git diff --check`
  - `rg "test\.todo|describe\.skip" e2e packages`
  - `npx --yes bun@1.3.13 run lint`
  - `npx --yes bun@1.3.13 run typecheck`
  - `npx --yes bun@1.3.13 test`
  - `npx --yes bun@1.3.13 run build`
  - `/bin/bash scripts/check-assets-hygiene.sh` if asset packaging surface is touched
  - `bash scripts/check-trace.sh` if failure/audit/SPEC trace surface is touched
