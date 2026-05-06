# Issue #88 TaskEntry runtime schema migration plan

## Goal

Implement Issue #88 by extending `tasks.yaml` runtime/session schema and config effort/timeout entry points while preserving v0.1 task/config compatibility.

## Tasks

- [x] Add failing coverage for new runtime fields, provider session migration, reverse-provider sessions, and empty legacy sessions in `packages/core/src/tasks.test.ts`.
- [x] Add failing coverage for `effort` config, invalid effort values, optional phase timeouts, and a number-returning timeout resolver in `packages/core/src/config.test.ts`.
- [x] Add failing init coverage that generated `.autokit/config.yaml` parses to core defaults and no longer drifts from `DEFAULT_CONFIG`.
- [x] Implement core types/schemas: `EffortLevel`, `ResolvedEffort`, `PhaseOverride`, unified provider sessions, runtime defaults, and `z.preprocess` legacy migration.
- [x] Implement `resolveRunnerTimeout()` in core and replace CLI executor timeout lookup with it.
- [x] Replace fixed init config YAML with core-default serialization.
- [x] Update workflow, reconcile, state-machine, retry-cleanup, and tests to compile against the unified provider session shape while preserving v0.1 default provider behavior.
- [x] Update `docs/SPEC.md` §2.2 / §4.1 / §4.2 for Issue #88 only.
- [x] Run focused tests, then `lint`, `typecheck`, full test, and build before PR.

## Done When

- [x] #88 AC pass: old/new tasks round-trip, 7 phase x 2 legacy session pattern coverage, effort config validation, init config sync, and typecheck.
- [x] No runner effort propagation, downgrade audit emission, redaction public API, or provider resume selection changes from #89+ are included.
- [ ] PR body includes `Closes #88`, `Related #80`, SSOT refs, commands/exit codes, CI status, provider-backed tests status, and residual risks.
