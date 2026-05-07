# Issue 109 Agents Boundary Alignment

## Goal
Align the six bundled agent assets with v0.2 Phase 4 role, responsibility, SoT, output, and permission boundaries without changing prompt_contract schemas or adding agents.

## Context
- Issue: #109 `[v0.2 4.3] agents 改修`
- SSOT: `docs/spec/phase4-quality.md` §3.1 / §3.2
- Dependency: #108 closed; #110 remains blocked by #109
- Reference: `docs/references/v0.2.0-issue-plan.md` Issue 4.3, `docs/spec/phase1-core-cli-runner.md` §1.5, `docs/SPEC.md` §1.4 / §2.2 / §9.4.2 / §11.4.3

## Scope
- Update only `packages/cli/assets/agents/*.md` and tests/gate code needed to enforce their quality.
- Add a focused runner-visibility quality gate for all six bundled agent assets.
- Keep existing agent names and prompt_contract schemas unchanged.

## Non-goals
- No new agent assets.
- No bundled skill or prompt schema changes.
- No live provider subprocess or API-key-backed run.
- No new failure.code, audit kind, or SPEC trace change.

## Tasks
- [x] Confirm #109 native blocked-by is satisfied and create issue worktree from latest `origin/main`.
- [x] Add RED coverage for six agent asset obligations: role, Do/Don't, decision rules, permission boundary, SoT, AI anti-patterns, and output format.
- [x] Update all six bundled agent markdown files with phase/capability-aligned boundaries.
- [x] Keep runner visibility and prompt_contract schema gates green.
- [x] Run focused checks, then required handoff gates.
- [ ] Create PR, run review, fix valid findings, update latest main, and merge.

## Test Plan
- RED: `npx --yes bun@1.3.13 test e2e/runners/runner-visibility.test.ts` should fail before agent asset updates.
- Focused GREEN: `npx --yes bun@1.3.13 test e2e/runners/runner-visibility.test.ts packages/core/src/runner-contract.test.ts packages/codex-runner/src/index.test.ts`
- Handoff gates: `npx --yes bun@1.3.13 run lint`, `npx --yes bun@1.3.13 run typecheck`, `npx --yes bun@1.3.13 test`, `npx --yes bun@1.3.13 run build`, `/bin/bash scripts/check-assets-hygiene.sh` via temp bun wrapper if local PATH lacks bun.
