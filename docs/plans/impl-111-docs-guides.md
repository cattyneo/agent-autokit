# Issue #111 v0.2 docs guide sync

## Goal
Update the user-facing and developer-facing guides for v0.2.0 capability, effort, preset, `autokit serve`, exit-code, and failure-scenario behavior without changing frozen SPEC content.

## Success Criteria
- [x] README and docsify user guide explain v0.2 capability / effort / preset / serve usage with runnable examples.
- [x] Troubleshooting and recovery docs cover `effort_unsupported`, `preset_path_traversal`, `preset_blacklist_hit`, and reused v0.2 failure scenarios.
- [x] CLI exit code `0` / `1` / `2` / `75` docs match current CLI behavior.
- [x] Dev guide describes capability table ownership, permission profiles, effort resolution, serve lock/auth boundaries, preset safety, and Phase 4 asset gates.
- [x] Docs navigation remains coherent and no `test.todo` / `describe.skip` is introduced.
- [x] Relevant markdown/docsify checks and common gates pass.

## Scope
- In: `README.md`, `guides/user/*.md`, `guides/dev/*.md`, sidebars if needed.
- In: a docs-only implementation plan under `docs/plans/`.
- Out: `docs/SPEC.md`, `docs/PLAN.md`, `docs/spec/*.md`, code behavior, prompt/skill/agent assets, new tests beyond docs checks.

## Source of Truth
- Issue #111 body and native blocked-by: #97, #102, #106 all closed.
- `docs/spec/cross-cutting.md` §1, §2, §5, §7.
- `docs/spec/phase1-core-cli-runner.md` §1, §3, §6, §7, §8.
- `docs/spec/phase2-serve-dashboard.md` §1.1-§1.5.
- `docs/spec/phase3-preset.md` §1-§4.
- `docs/spec/phase4-quality.md` §1-§3.
- `docs/references/v0.2.0-issue-plan.md` Issue D.1.
- Current implementation in `packages/core/src/{capability,config,effort-resolver,failure-codes}.ts`, `packages/cli/src/index.ts`, and `packages/serve/src/index.ts`.

## Tasks
- [x] Update README support/basic-flow docs with v0.2 capability, presets, serve, config show, logs/diff, and safety notes.
- [x] Update user command/config/workflow/recovery/troubleshooting pages for v0.2 commands, override syntax, config fields, exit codes, and failure playbooks.
- [x] Update developer architecture/state-machine/prompt-contract/safety/glossary pages for capability table, effort resolver, serve lock/auth, preset safety, and asset gates.
- [x] Run formatting/lint-sensitive docs checks, docsify/static sanity where applicable, then required gates.

## Verification Plan
- `rg "test\\.todo|describe\\.skip" e2e packages guides docs README.md`
- `npx --yes bun@1.3.13 x biome check README.md guides docs/plans/impl-111-docs-guides.md`
- `npx --yes bun@1.3.13 run lint`
- `npx --yes bun@1.3.13 run typecheck`
- `npx --yes bun@1.3.13 test`
- `npx --yes bun@1.3.13 run build`
- `/bin/bash scripts/check-assets-hygiene.sh` via pinned temporary bun wrapper
- `bash scripts/check-trace.sh`
