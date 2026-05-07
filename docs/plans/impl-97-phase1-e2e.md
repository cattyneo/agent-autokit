# Issue #97 Implementation Plan: Phase 1 E2E gate

## 1. Purpose

Issue #97 closes the Phase 1 integration gate after Issues #87-#96 are merged. The PR must prove the Phase 1 observable completion conditions with fake runners / fake GitHub evidence and without live provider subprocesses.

## 2. Scope

- Add a Phase 1 E2E gate test that exercises the cross-feature chain not covered by isolated Issue tests.
- Keep the gate fixture in `e2e/runners`, because the assertions span CLI production executor, workflows, core config / effort resolution, runner contracts, and fake GitHub evidence.
- Use fake `WorkflowRunner` outputs and mocked `gh` / `git` command responses only.
- Add a narrow operational audit kind for successful phase completion and verify the trace gate with `bash scripts/check-trace.sh`.

## 3. Non-Scope

- No live Claude / Codex / API-key-backed subprocess run.
- No P2A serve / lock, P3 preset, P4 prompt asset changes.
- No new failure.code.
- No changes to `docs/PLAN.md`.

## 4. Acceptance Mapping

- Default provider split E2E completion: keep `packages/cli/src/executor.test.ts` coverage and add P1 gate references through the new integration fixture.
- Provider override + capability table: run `phaseOverride` with `plan -> codex` and assert readonly permission remains fixed.
- Effort resolution: assert `codex` + `high` + `gpt-5.5` resolves as supported with no `effort_downgrade` audit.
- Doctor invalid config: keep existing CLI doctor coverage; P1 gate required commands will include full CLI tests.
- Review/CI loop failure codes: keep active `review-fix-loop.test.ts` and `ci-fix-loop.test.ts` gates.
- Self-correction: force one review `prompt_contract_violation`, assert exactly one `phase_self_correct` audit and persisted `runtime.phase_self_correct_done=true`.
- Phase completion audit: assert `phase_completed` records completed runner phases after prompt_contract validation.
- Legacy tasks compatibility: keep active legacy fixture load tests and full `bun test` gate.
- Trace: run `bash scripts/check-trace.sh`.

## 5. Implementation Steps

1. Add RED test in a new `e2e/runners/phase1-gate.test.ts`.
2. Build a temp repo fixture with fast config, prompt assets, tasks.yaml, and mocked `gh` / `git` responses.
3. Run a production workflow segment with `phaseOverride: { phase: "plan", provider: "codex", effort: "high" }`.
4. Force review self-correction and interruption, then resume the workflow from the persisted task state to final merged state.
5. Assert audit sequence, runner calls, persisted runtime fields, absence of downgrade audit, final OBS smoke evidence, and no live provider path.
6. Run targeted E2E tests, trace gate, then required gates.

## 6. Open Questions

- None. #97 native blocked-by is fully closed (#87-#96), and open PR list was empty before starting.
