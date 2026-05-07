# Issue #105 Implementation Plan: initial bundled presets

## Goal

Bundle the four Phase 3 presets (`default`, `laravel-filament`, `next-shadcn`, `docs-create`) and prove they can be listed, shown, applied, doctored, packed, and used with a fake workflow runner without changing the prompt contract schema.

## Context

- Issue: #105 `[v0.2 3.3] 初期 preset 4 種`
- Dependencies: native `blockedBy` is #104 and #107; both are closed.
- Worktree/branch: `.agents/worktrees/issue-105-initial-presets` / `codex/issue-105-initial-presets`
- SSOT:
  - `docs/spec/phase3-preset.md` §1, §4
  - `docs/spec/phase4-quality.md` §2.1
  - `docs/references/v0.2.0-issue-plan.md` Issue 3.3
  - `docs/SPEC.md` §8.3 as the v0.1 frozen skill SoT

## Scope

- Add `packages/cli/assets/presets/{default,laravel-filament,next-shadcn,docs-create}/`.
- For each preset, include `config.yaml` plus tracked `prompts/`, `skills/`, and `agents/` override files.
- Keep all prompt overrides limited to free-text guidance and preserve prompt-contract marker sections.
- Extend the prompt-contract mapping fixture so Issue #107's preset effective prompt scanner covers all four bundled presets.
- Add CLI fixture coverage that applies each bundled preset, runs `doctor`, checks `.autokit/.gitignore`, and completes `autokit run` through a fake workflow seam.
- Update `docs/SPEC.md` §8.3 with the required note that preset-origin skill overrides are allowed only through the preset mechanism and must keep the same skill contracts.

## Non-Scope

- No `preset apply --dry-run` or `preset export`.
- No new preset command behavior, path traversal, blacklist, protected-array, audit kind, or failure code changes.
- No live provider subprocess or API-key-backed run.
- No actual Laravel, Next.js, or docs project generation.

## Acceptance Criteria

- `preset list` shows all four bundled presets.
- `preset show <name>` sanitizes and displays the bundled preset contents.
- `preset apply <name>` succeeds for each bundled preset, then `doctor` passes.
- `autokit run` can complete against each preset fixture using the fake workflow seam.
- `.autokit/.gitignore` remains `*` based and is not opened for bundled preset assets.
- Prompt-contract schema snapshot remains unchanged.
- Prompt visibility gate passes for base prompts and all four preset effective prompt sets.
- `bun pm pack --dry-run` / assets hygiene includes `assets/**`, including bundled presets.

## Test Scenarios

- RED: CLI test expects the four bundled presets to exist and apply; it fails before assets are added.
- RED: prompt visibility gate fails because preset effective prompt mapping rows are missing.
- GREEN: add preset assets and mapping rows, then rerun focused tests.
- Regression: run CLI preset tests, runner visibility/schema tests, full repo tests, build, lint, typecheck, and assets hygiene.

## Implementation Steps

1. Add focused failing tests for bundled preset list/show/apply/doctor/fake-run and mapping coverage.
2. Add four preset directories with safe config, prompt, skill, and agent overrides.
3. Add mapping rows for each preset effective prompt set.
4. Update SPEC §8.3 with the preset skill override note.
5. Run focused tests first, then required gates.

## Validation Plan

- `npx --yes bun@1.3.13 test packages/cli/src/index.test.ts e2e/runners/runner-visibility.test.ts packages/codex-runner/src/index.test.ts packages/core/src/runner-contract.test.ts`
- `npx --yes bun@1.3.13 run lint`
- `npx --yes bun@1.3.13 run typecheck`
- `npx --yes bun@1.3.13 run build`
- `npx --yes bun@1.3.13 test`
- `/bin/bash scripts/check-assets-hygiene.sh`
- `bash scripts/check-trace.sh` is not expected because this issue adds no failure.code, audit kind, or SPEC trace mapping.
