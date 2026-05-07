# Implementation Plan: Issue #112 normal E2E

## Goal

Add an active required E2E test for the v0.2 normal user journey: `init` -> `preset apply` -> `add` -> `run` -> CI success -> auto-merge -> cleanup, across the 4 bundled initial presets, without live Claude/Codex or real GitHub dispatch.

## Observable success criteria

- [x] `e2e/runners/happy-path.test.ts` covers `default`, `laravel-filament`, `next-shadcn`, and `docs-create`.
- [x] Each scenario uses CLI-level `init`, `preset apply`, `add`, and `run`, then exits `0`.
- [x] Each scenario ends with `tasks.yaml.tasks[0].state === "merged"` and removes `.autokit/worktrees/issue-112`.
- [x] Each scenario observes stable audit evidence including preset apply, phase completion, auto-merge reservation, sanitize pass, and branch deletion.
- [x] The fake runner / fake gh harness fails if a live `claude` or `codex` subprocess would be invoked.
- [x] The test is part of normal `bun test` discovery with no `test.todo` / `describe.skip`.

## Key constraints

- Scope is happy path only. Failure scenarios belong to #113.
- Do not change production behavior or SPEC files.
- Required E2E must use fake `WorkflowRunner` / fake `gh` and must not require provider credentials.
- Keep helper code local to the test unless another E.* issue clearly needs extraction later.

## Source of truth

- Live Issue #112.
- `docs/references/v0.2.0-issue-plan.md` Issue E.1 and Phase E harness policy.
- `docs/spec/cross-cutting.md` Phase E2E policy and audit/failure boundaries.
- Existing harnesses: `e2e/runners/phase3-gate.test.ts`, `e2e/runners/phase4-gate.ts`, `e2e/runners/full-run.test.ts`.

## Execution steps

- [x] Create `e2e/runners/happy-path.test.ts` with a 4-preset table test.
- [x] Build a temp repo harness using `runCli`, `init`, `preset apply`, `add`, and production `run`.
- [x] Add fake `gh` / `git` exec handling for issue fetch, PR creation, CI success, auto-merge, and cleanup.
- [x] Add a fake `WorkflowRunner` that returns valid prompt-contract data for `plan`, `plan_verify`, `implement`, and `review`.
- [x] Assert final task state, worktree cleanup, audit sequence, resolved effort persistence, preset-specific prompt injection, CI-before-merge ordering, PR number persistence, cwd boundaries, and absence of provider subprocess commands.
- [x] Run focused E2E, then common gates.

## Initial RED

- `npx --yes bun@1.3.13 test e2e/runners/happy-path.test.ts` -> exit 1 because the target test file does not exist yet.

## Focused verification

- `npx --yes bun@1.3.13 install` -> exit 0.
- `npx --yes bun@1.3.13 run build` -> exit 0 (needed before focused test because workspace package exports point at `dist/`).
- `npx --yes bun@1.3.13 test e2e/runners/happy-path.test.ts` -> exit 0, 2 pass after review-fix.
- `npx --yes bun@1.3.13 test e2e/runners/happy-path.test.ts e2e/runners/phase3-gate.test.ts e2e/runners/phase4-gate.test.ts packages/cli/src/executor.test.ts` -> exit 0, 18 pass after review-fix.
- `npx --yes bun@1.3.13 x biome check e2e/runners/happy-path.test.ts docs/plans/impl-112-normal-e2e.md` -> exit 0 after formatting.

## Review-fix notes

- Fixed valid `$general-review` findings by asserting preset-specific implement/review prompt markers, fake PR number distinct from Issue number, `execFile` cwd boundaries, CI status observation before auto-merge reservation, MERGED observation before branch/worktree cleanup, temp fixture cleanup, and API-key-env fail-closed behavior before default provider dispatch.

## Required gate verification

- `git diff --check` -> exit 0.
- `rg "test\.todo|describe\.skip" e2e packages` -> exit 1, no matches.
- `npx --yes bun@1.3.13 run lint` -> exit 0 with existing non-blocking warnings in `guides/index.html` and existing Biome infos in `e2e/runners/spike-runner-stability.ts`.
- `npx --yes bun@1.3.13 run typecheck` -> exit 0.
- `npx --yes bun@1.3.13 test` -> exit 0, 501 pass after review-fix.
- `npx --yes bun@1.3.13 run build` -> exit 0.
- `/bin/bash scripts/check-assets-hygiene.sh` with a temporary `bun` wrapper for `npx --yes bun@1.3.13` -> exit 0, 46 files, assets hygiene passed.
- `bash scripts/check-trace.sh` -> exit 0, traceability checks passed.
