# Issue #115 Implementation Plan: Legacy Compatibility E2E

## Goal

Add the Phase E.4 backwards compatibility E2E gate so v0.1-style `tasks.yaml` provider session shapes and older `config.yaml` files remain accepted by the v0.2 runtime.

## Observable Success Criteria

- `e2e/legacy/*.test.ts` is active under `bun test` with no `test.todo` or `describe.skip`.
- The 14 existing legacy task fixtures, covering 7 agent phases x 2 session patterns, pass through the CLI `autokit resume` parse/write gate.
- Empty legacy sessions normalize with `last_provider: null` and fresh task sessions remain schema-compatible.
- Legacy config with missing `effort` and `runner_timeout.<phase>_ms` parses with `medium` defaults and resolves a numeric timeout.
- Existing `e2e/runners/full-run.test.ts` remains green.

## Key Constraints

- SSOT priority: `docs/spec/*.md`, then `docs/references/v0.2.0-issue-plan.md` Issue E.4, then live Issue #115, then frozen `docs/SPEC.md` / `docs/PLAN.md`.
- Do not add new schema features; Issue #88 already owns migration behavior.
- Do not expand into #116 assets hygiene or #117 trace exactness.
- Do not run live provider subprocesses or API-key-backed workflows.
- Root checkout has user-dirty `AGENTS.md`; all edits stay in this worktree.

## Scope

- Add active E2E tests under `e2e/legacy`.
- Reuse existing fixtures under `e2e/fixtures/legacy-tasks-yaml`.
- Use CLI test seams / fake workflow runner so `autokit resume` exercises CLI parse, transition, normalization, and write-back without live providers.
- Add minimal legacy config fixture coverage for omitted effort and runner timeout fields.

## Non-Scope

- New migration semantics beyond the #88 behavior already implemented in `packages/core/src/tasks.ts` and `packages/core/src/config.ts`.
- Live Claude/Codex resume.
- Assets packaging or trace CI gate changes.

## Test Scenarios

1. Legacy tasks:
   - For each 14 fixture, write a paused v0.1-style task with missing v0.2 runtime fields and fixture `provider_sessions`.
   - Run `autokit resume <issue>` through `runCli`.
   - Assert write-back normalizes `provider_sessions.<phase>.{claude_session_id,codex_session_id,last_provider}` and runtime additions to `null`.
2. Empty sessions:
   - Write all phase sessions as empty objects / null-like entries and assert `last_provider` remains `null`.
   - Assert a fresh task has all provider session objects non-null and `last_provider: null`.
3. Legacy config:
   - Parse an older config without `effort` or phase runner timeouts.
   - Assert default effort is `medium`, unsupported policy is `fail`, and `resolveRunnerTimeout` returns deterministic numbers, including effort-derived timeout when supplied.
4. Regression:
   - Run new E2E plus existing `e2e/runners/full-run.test.ts`.

## Dependencies

- #97 and #106 are closed.
- #114 is closed and merged; #115 is the lowest open child by issue-plan order.

## References

- Issue #115: `[v0.2 E.4] 後方互換 E2E`
- `docs/references/v0.2.0-issue-plan.md` Issue E.4
- `docs/spec/README.md`
- `docs/SPEC.md` §4.2, §5.1.3, §7.1, §13.1
- `docs/PLAN.md` v0.1 operational reference

## Execution Steps

1. Add RED E2E file under `e2e/legacy`.
2. Run the new E2E and confirm it is active.
3. Keep implementation limited to tests unless the E2E exposes an actual migration gap.
4. Run targeted E2E plus relevant core/CLI tests.
5. Run full required gates before PR.
