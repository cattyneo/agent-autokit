# Issue 87 capability table SoT

## Goal
Add the v0.2 core-owned capability table and validation entry point for all agent phases/providers without changing runner consumption yet.

## Success Criteria
- `@cattyneo/autokit-core` exports `capabilities`, `deriveClaudePerm`, `deriveCodexPerm`, and validation helpers.
- The table contains exactly 14 rows: 7 `agent_phase` values x 2 providers, excluding `ci_wait` and `merge`.
- Runtime validation rejects unknown phase/provider values and provider assignment for `ci_wait` / `merge`.
- `docs/SPEC.md` §2.2 notes that v0.2 migrates provider assignment to the capability table.
- Core unit tests cover snapshot, invalid combinations, and read-only denied tools.

## Scope
- In: `packages/core/src/capability.ts`, core exports, config validation entry, core tests, SPEC §2.2 note.
- Out: runner consumption, `init.ts` default config rewrite, effort resolver, failure.code / audit kind changes.

## SSOT
- Issue #87
- `docs/references/v0.2.0-issue-plan.md` Issue 1.1
- `docs/spec/phase1-core-cli-runner.md` §1 and §2
- `docs/SPEC.md` §2.2 / §11.4.3

## Tasks
- [x] Add failing core capability tests covering the Issue #87 AC.
- [x] Implement `packages/core/src/capability.ts` with phase/provider/profile table and derive helpers.
- [x] Wire config runtime validation through the capability helper while preserving existing defaults.
- [x] Export the new public core surface from `packages/core/src/index.ts`.
- [x] Add the SPEC §2.2 migration note.
- [x] Run focused tests, then required gates.

## Verification
- `bun test packages/core/src/capability.test.ts packages/core/src/config.test.ts`
- `bun run typecheck`
- `bun test`
- `bun run lint`
- `bun run build`
