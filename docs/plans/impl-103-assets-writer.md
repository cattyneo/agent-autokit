# Issue #103 assets-writer primitive

## Goal
Add a core-owned `assets-writer` primitive that can drive both current `autokit init` and later `preset apply`, while keeping preset discovery and bundled asset root resolution in CLI.

## Observable Success Criteria
- `packages/core/src/assets-writer.ts` exports path-based backup / rollback / manifest / retention helpers without referencing `packages/cli/assets/**` or preset names.
- `autokit init` keeps existing behavior but uses the core primitive for file copy, backup, rollback, and retention pruning.
- Core exposes `<repo-id> = sha256(realpath(repoRoot)).slice(0,16)` and XDG preset backup path helpers with parent chain mode `0700`.
- `init.backup.retention_days` defaults to 30 and parse / serialize behavior is covered.
- Existing init tests stay green and new tests cover same-basename different-realpath backup separation, retention fail-closed behavior, and byte-identical rollback.

## Scope
- `packages/core/src/assets-writer.ts` and tests.
- `packages/core/src/config.ts` / config tests for `init.backup.retention_days`.
- `packages/cli/src/init.ts` migration to core primitive while retaining CLI asset-root resolution.
- `docs/SPEC.md` §4.1 / §11.5 update for retention and XDG preset backup tree.

## Non-goals
- No `autokit preset list/show/apply` command.
- No initial bundled preset pack.
- No new `failure.code` / audit kind / `check-trace` owner changes. `preset_path_traversal`, `preset_blacklist_hit`, and `preset_apply_*` remain #104.
- No YAML task schema migration.

## Constraints
- Core must not import CLI or know package asset paths.
- `init.backup_blacklist` remains the shared blacklist source; path traversal and content signature enforcement are #104.
- Keep `autokit init` transactional behavior and rollback error contract compatible with existing tests.
- Retention deletion failure must fail closed instead of silently skipping.

## Execution Steps
- [x] Add RED core tests for assets transaction backup/rollback, repo-id/XDG path/modes, and retention failure.
- [x] Add RED config tests for `init.backup.retention_days`.
- [x] Add/adjust init tests for retention pruning and unchanged transaction behavior.
- [x] Implement core `assets-writer` primitive and exports.
- [x] Migrate `packages/cli/src/init.ts` to use the primitive.
- [x] Update SPEC references and run targeted checks before required gates.

## Validation Plan
- `npx --yes bun@1.3.13 run typecheck`
- `npx --yes bun@1.3.13 test packages/core/src/assets-writer.test.ts packages/core/src/config.test.ts packages/cli/src/index.test.ts`
- `npx --yes bun@1.3.13 run lint`
- `npx --yes bun@1.3.13 test`
- `npx --yes bun@1.3.13 run build`
- `bash scripts/check-trace.sh`
- `PATH=<temp bun wrapper> /bin/bash scripts/check-assets-hygiene.sh`

## SSOT
- GitHub Issue #103.
- `docs/spec/phase3-preset.md` §3 / §3.3 / §3.4.
- `docs/references/v0.2.0-issue-plan.md` Issue 3.1 and implementation order.
- `docs/SPEC.md` §4.1 / §11.5.
