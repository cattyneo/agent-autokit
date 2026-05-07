# Issue #116 assets-hygiene E2E

## Goal
Make the assets hygiene release gate observable in active E2E/CI: pack dry-run contents, forbidden publish entries, CLI bin self-containment, installed `autokit serve`, dashboard exclusion, and `packages/cli` `private:true`.

## Observable Success Criteria
- `e2e/hygiene/pack-dry-run.test.ts` runs in `bun test` without `todo`/`skip`.
- `scripts/check-assets-hygiene.sh` still passes after `bun run build` and is covered by `.github/workflows/assets-hygiene.yml`.
- Pack dry-run output includes all bundled preset trees: `default`, `laravel-filament`, `next-shadcn`, `docs-create`.
- Pack dry-run output rejects the SPEC/PLAN forbidden patterns and keeps `packages/cli/package.json` `private:true`.
- `packages/cli/dist/bin.js` has no `workspace:` or unresolved `@cattyneo/autokit-*` imports, includes serve runtime, excludes dashboard runtime, and can start installed `autokit serve`.

## Constraints
- Scope is hygiene only: no functional/security scenario expansion from E.1-E.4.
- No live Claude/Codex/API-key-backed provider execution.
- Root checkout has dirty `AGENTS.md`; all edits stay in this worktree.
- Keep `packages/cli/package.json` `private:true`.

## Relevant Skills / Tools
- Skills: `agent-autokit-issue-train`, `issue-implementation`, `plan-writing`.
- Tools: `rg`, `bun test`, `bun run build`, `scripts/check-assets-hygiene.sh`, GitHub PR/CI checks.

## Execution Steps
- [x] Add RED E2E for #116 expected hygiene behavior.
- [x] Implement test helpers and any minimal script hardening needed for the E.5 AC.
- [x] Run targeted hygiene tests and `scripts/check-assets-hygiene.sh`.
- [x] Run required gates: lint, typecheck, test, build, and assets hygiene.
- [ ] Commit, push, open PR, run general review, fix valid findings, verify CI, merge.
