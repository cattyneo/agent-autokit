# Issue #104 Implementation Plan: preset list/show/apply

## Goal

Implement `autokit preset {list,show,apply}` for v0.2 Phase 3.2, including preset path/content safety, protected array guardrails, lock consumption, rollback/audit observability, and SPEC trace updates for the new preset failure codes and audit kinds.

## Context

- Issue: #104 `[v0.2 3.2] preset list / show / apply + path traversal + blacklist + protected array`
- Dependencies: #102 and #103 are closed; live native `blockedBy` is empty at restart.
- Branch/worktree: `codex/issue-104-preset-apply` in `.agents/worktrees/issue-104-preset-apply`.
- SSOT:
  - `docs/spec/phase3-preset.md` §2, §3.1, §3.2, §3.3, §3.4
  - `docs/spec/cross-cutting.md` §1, §1.1, §2.1, §2.2
  - `docs/references/v0.2.0-issue-plan.md` Issue 3.2
  - `docs/SPEC.md` §4.2.1.1, §10.2.2.1, §10.2.2.2, §11.5

## Scope

- Add CLI `preset list`, `preset show <name>`, and `preset apply <name>`.
- Discover bundled presets under `packages/cli/assets/presets/<name>` and local presets under `.autokit/presets/<name>`, with local priority.
- Reject path traversal, symlink, NUL, blacklist path, and content signature hits with category-only public messages.
- Merge preset `config.yaml` into `.autokit/config.yaml`, enforcing protected arrays:
  - `logging.redact_patterns`
  - `init.backup_blacklist`
  - deprecated `permissions.claude.allowed_tools`
- Consume the Phase 2A run lock before state-changing apply work and before backup/staging writes.
- Use #103 core assets primitives for backup, rollback, and manifest checks.
- Add `preset_path_traversal` / `preset_blacklist_hit` failure codes and five `preset_apply_*` operation audit kinds.
- Update SPEC trace in the same PR.

## Non-Scope

- Initial bundled preset contents (`default`, `laravel-filament`, `next-shadcn`, `docs-create`) are #105.
- Provider-backed runner execution is not run.
- Full P3-E2E API-side `POST /api/run` 409 fixture is owned by P3-E2E; #104 validates CLI lock consumption and unchanged `.agents` / `tasks.yaml`.
- Redaction public API extraction beyond existing `sanitizeLogString` reuse remains later scope.

## Acceptance Criteria

- `preset list` shows source and applies local priority.
- `preset show` emits safe content/protected diff and refuses sensitive entries without leaking literal path/token/pattern values.
- `preset apply` exits 75 when the run lock is busy and mutates neither `.agents` nor backup/staging.
- Valid preset apply writes merged config and asset files, runs doctor-like validation, emits started/finished audits, and leaves `tasks.yaml` untouched.
- Blacklist, traversal, NUL, symlink, and protected array violations exit 1 with `preset_*` failure audit and category-only stderr.
- Rename/post-apply validation failure restores the pre-apply manifest and emits rollback audits.
- `bash scripts/check-trace.sh` is green after SPEC/logger/failure-code updates.

## Test Scenarios

- CLI `preset list` local priority over bundled source.
- CLI `preset show` redacts or refuses private key/token/sensitive path entries.
- CLI `preset apply` safe preset merges config and copies prompt/skill/agent files.
- Busy lock blocks `preset apply` before backup or `.agents` mutation.
- Casefold `.ENV`, symlink, parent `.agents` symlink, NUL, and private key content fail closed.
- Protected arrays fail closed without `--allow-protected-replace`; allowed union succeeds.
- Injected post-apply doctor failure restores `.agents` and logs rollback started/finished.
- Logger/SPEC trace test includes new preset codes/kinds.

## Implementation Steps

1. Add RED CLI/core logger tests for #104 AC.
2. Add core failure/audit kind constants and update `docs/SPEC.md` trace.
3. Add `packages/cli/src/preset.ts` for discovery, validation, merge, apply, audit, and rollback helpers.
4. Wire `preset` subcommands in `packages/cli/src/index.ts` and extend `CliDeps` only for test seams.
5. Add direct CLI dependencies needed by implementation (`yaml`, `minimatch`) and refresh lockfile.
6. Run focused tests first, then lint/typecheck/full test/build and trace gate.

## Validation Plan

- `npx --yes bun@1.3.13 install --frozen-lockfile`
- `npx --yes bun@1.3.13 test packages/cli/src/index.test.ts packages/core/src/logger.test.ts`
- `npx --yes bun@1.3.13 run lint`
- `npx --yes bun@1.3.13 run typecheck`
- `npx --yes bun@1.3.13 test`
- `npx --yes bun@1.3.13 run build`
- `bash scripts/check-trace.sh`
- `/bin/bash scripts/check-assets-hygiene.sh` with a temporary Bun wrapper if the environment PATH lacks `bun`
