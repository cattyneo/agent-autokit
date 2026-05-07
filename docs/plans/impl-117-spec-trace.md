# Issue 117 SPEC Trace Gate

## Goal
Add an active E2E trace gate that proves SPEC failure codes, failure audit kinds, operational audit kinds, and the E34 self-correction condition stay synchronized with implementation.

## Success Criteria
- `e2e/trace/spec-trace.test.ts` runs under normal `bun test`.
- The test executes `bash scripts/check-trace.sh` and requires exit 0.
- `failureCodes`, `failureAuditKinds`, and SPEC §4.2.1.1 / §10.2.2.2 match exactly.
- `operationalAuditKinds` and SPEC §10.2.2.1 match exactly, including the v0.2 owner kinds from Issue E.6.
- SPEC §5.1 has exactly one E34 row and that row contains `runtime.phase_self_correct_done=true`.

## Constraints
- Scope is trace only; assets hygiene remains #116 / E.5.
- No new failure.code or audit kind is introduced in this PR.
- Do not edit `docs/SPEC.md` unless the new gate exposes a real mismatch.
- No live provider subprocess or API-key-backed run.

## Steps
- [x] Run the missing trace test path first to capture RED.
- [x] Add `e2e/trace/spec-trace.test.ts` with SPEC parsers and implementation imports.
- [x] Run the targeted trace test and `bash scripts/check-trace.sh`.
- [x] Run full required gates before PR handoff.
- [x] Create PR with `Closes #117` and CI/check evidence.

## Verification
- `npx --yes bun@1.3.13 test ./e2e/trace/spec-trace.test.ts`
- `bash scripts/check-trace.sh`
- `npx --yes bun@1.3.13 run lint`
- `npx --yes bun@1.3.13 run typecheck`
- `npx --yes bun@1.3.13 test`
- `npx --yes bun@1.3.13 run build`
