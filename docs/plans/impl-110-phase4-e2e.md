# Issue #110 Phase 4 E2E gate

## Goal
Phase 4 child issues #107-#109 の成果を、live providers / real GitHub CLI に依存しない required E2E gate として観測できる状態にする。

## Observable Success Criteria
- `e2e/runners/phase4-gate.test.ts` が fake `WorkflowRunner` / mocked gh+git boundary で 1 task の 7 phase (`plan`, `plan_verify`, `implement`, `review`, `supervise`, `fix`, `review`) を通す。
- 同じ gate 内で prompt asset gate、skill asset gate、agent asset gate、prompt_contract payload validation、codex schema snapshot、self-correction 1 回収束を観測する。
- required gate は `claude` / `codex` subprocess と live provider API を呼ばない。

## Scope
- Add Phase 4 E2E test coverage under `e2e/runners/`.
- Reuse existing `runner-visibility` gates and workflow fake runner patterns.
- Add small test-only exports/helpers only if required to avoid duplicating gate logic.

## Out of Scope
- Prompt / skill / agent asset prose changes.
- `prompt_contract` schema changes.
- New failure code / audit kind / SPEC trace changes.
- Preset behavior changes outside the already-covered prompt/skill/agent gates.

## SSOT
- `docs/spec/phase4-quality.md` §観測可能な完了条件, §2.1, §2.3, §3.2
- `docs/references/v0.2.0-issue-plan.md` Issue P4-E2E
- `docs/SPEC.md` §8.3, §9.3, §9.4.3, §11.4.3
- Issue #110 live scope / non-goals / blocked-by

## Tasks
- [x] Add RED Phase 4 gate test that expects a missing integration helper/gate and fails.
- [x] Implement the Phase 4 gate using real bundled assets plus fake runner / mocked gh+git boundary.
- [x] Assert all 7 phases are observed, self-correction happens exactly once, and no provider subprocess command is invoked.
- [x] Run focused checks: `npx --yes bun@1.3.13 test e2e/runners/phase4-gate.test.ts e2e/runners/runner-visibility.test.ts packages/workflows/src/index.test.ts packages/codex-runner/src/index.test.ts`.
- [x] Run required gates before PR: lint, typecheck, test, build, assets hygiene; run trace only if touched.

## Notes
- Keep this PR test-focused. If existing gate exports are insufficient, prefer narrow test helper exports over duplicating production logic.
