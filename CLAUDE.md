# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`agent-autokit` is a local issue-train runtime that drives a GitHub Issue through plan / implement / review / CI / merge / cleanup using Claude CLI (`claude -p`) and Codex CLI (`codex exec`) as runners. The CLI is `autokit`, distributed via `packages/cli`.

v0.1.0 is intentionally a **private MVP** scoped to Apple Silicon macOS, fixture-like repositories, and CLI subscription auth. `packages/cli/package.json` MUST remain `private: true` — `npm publish` is out of scope and the assets-hygiene gate enforces it.

## Common Commands

Bun workspace monorepo (`bun@1.3.13`, package manager pinned in `package.json`).

```bash
bun install                     # install workspace deps
bun run lint                    # biome check . && eslint . (custom rule: no-unsafe-child-process-env)
bun run typecheck               # tsc -b across all package references
bun test                        # bun test runner across packages/*
bun run build                   # build all packages (tsc -b + bun build for CLI bin)
bun run format                  # biome format --write .
/bin/bash scripts/check-assets-hygiene.sh   # verify private:true + no forbidden publish entries
bash scripts/check-trace.sh                 # SPEC failure.code ↔ audit-kind 1:1 traceability
```

Run a single test file (Bun's runner, no Jest config):
```bash
bun test packages/core/src/state-machine.test.ts
bun test --filter "transitionTask"          # filter by test name pattern
```

CLI smoke after `bun run build`:
```bash
cd packages/cli && bun pm pack && cd -
# install the resulting .tgz globally for live runs
```

The full release-verification gates (preflight + tarball + bun-link install paths) are documented in README.md and `docs/artifacts/`. CI runs lint/typecheck/test on macos-14 and assets-hygiene on ubuntu-latest (`.github/workflows/`).

## Architecture

### Package layout (workspaces under `packages/*`)

| Package | Responsibility |
|---|---|
| `@cattyneo/autokit-core` | State machine, tasks.yaml persistence (atomic write), git/gh argv builders, prompt-contract schema, model resolver, audit logger, reconcile, retry-cleanup. **Single owner of all git/gh/PR/merge/cleanup mutations.** |
| `@cattyneo/autokit-workflows` | Phase orchestration (plan / plan_verify / plan_fix / implement / review / supervise / fix / ci_wait / merge). Calls runners; does not touch git directly. |
| `@cattyneo/autokit-claude-runner` | `claude -p` invocation layer. Returns prompt-contract structured output. |
| `@cattyneo/autokit-codex-runner` | `codex exec` invocation layer. Same contract surface as claude-runner. |
| `@cattyneo/autokit-tui` | Ink-based progress + question-prompt UI (`render-model.ts`, `ink-components.tsx`). |
| `@cattyneo/autokit` (`packages/cli`) | `autokit` binary (`commander`). Wires deps, owns top-level command flow (`init`/`add`/`run`/`resume`/`retry`/`cleanup`/`doctor`/`list`/`status`). Carries copy-on-init `assets/` (agents, prompts, skills). |

The dependency direction is one-way: `cli → workflows → runners → core`. Runners and workflows must not call `git`/`gh` themselves — those calls live in `core` (see argv builders in `packages/core/src/git.ts` and `gh.ts`). Violations are caught by the custom ESLint rule `autokit/no-unsafe-child-process-env` (`scripts/eslint-rules/`).

### State machine and exit codes

`packages/core/src/state-machine.ts` is the canonical state machine. There are nine `runtime_phase` values (`plan / plan_verify / plan_fix / implement / review / supervise / fix / ci_wait / merge`); `ci_wait` and `merge` are core-only and never reach a runner. `TransitionEvent` enumerates all legal transitions — extend the union when adding a new edge, do not bypass it.

`autokit run` exit codes (computed in `packages/cli/src/index.ts:getWorkflowExitCode`):
- `0` — every selected task reached `merged`.
- `1` — any task `failed`.
- `75` (TEMPFAIL) — at least one task is `paused` or `cleaning`. This is the "resumable state" signal: branch protection, rate limit, head-mismatch, runner `need_input`, etc. Re-run `autokit run` or `autokit resume` to continue.

The `--match-head-commit` style head_sha check exists at four observation sites (see SPEC §1.4 — `pre_reservation_check` / `post_reservation_recheck` / `merged_oid_match` / `reconcile_observation`); audit logs identify them by site name, not by index.

### Assets and `autokit init`

`packages/cli/assets/` ships the prompt contracts (`prompts/*.md`), agent definitions (`agents/*.md`), and skill packages (`skills/autokit-{implement,question,review}/`). `autokit init` copies them into the target repo's `.agents/` tree. `doctor` validates that the prompt-contract filenames in `.agents/prompts/` match `DEFAULT_CONFIG.phases[*].prompt_contract`. Adding/renaming a prompt requires updating both `DEFAULT_CONFIG` and the asset filename in lockstep.

## Critical Constraints

### Authentication and secrets (enforced)

- Live runs require `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CODEX_API_KEY` to be **unset** — `doctor` and `init` fail otherwise (`packages/cli/src/index.ts:checkEnvUnset`). Use the CLI subscription / auth state instead.
- Never read or quote `~/.codex/auth.json` or `$CODEX_HOME/auth.json` (or copy their contents into logs / artifacts / Issues / PRs). Same applies to `~/.claude/credentials*`.
- `doctor` also scans `cwd` `.env*` files for those three keys; commits that introduce them will fail.

### Private-distribution invariants (assets-hygiene gate)

`scripts/check-assets-hygiene.sh` (run in `assets-hygiene` workflow and locally before release) blocks:
- `packages/cli/package.json` losing `"private": true`.
- `bun pm pack --dry-run` / `npm pack --dry-run` output containing `__MACOSX`, `.DS_Store`, `.claude/state`, `.claude/sessions`, `.claude/credentials`, `.codex/auth`, `.codex/credentials`, `.env*`, `*.pem`, or `id_rsa*`.
- The publish candidate (`packages/cli/dist/bin.js` and the CLI `package.json`) referencing `workspace:` specifiers or unresolved `@cattyneo/autokit-{core,workflows,claude-runner,codex-runner,tui}` imports — the CLI bin must be a self-contained `bun build` bundle.

When editing the CLI build pipeline or adding files under `packages/cli/`, run `bun run build && /bin/bash scripts/check-assets-hygiene.sh` before opening a PR. On macOS, prefer `/bin/bash` for that script (Homebrew bash can stall on its here-strings).

### SPEC ↔ implementation traceability

`docs/SPEC.md` is the authoritative spec; `docs/PLAN.md` is the roadmap. `scripts/check-trace.sh` verifies that the failure-code list (SPEC §4.2.1.1) and the audit-kind list (SPEC §10.2.2.2) are 1:1 — when adding a new `failure.code` in `packages/core/src/failure-codes.ts` (or `logger.ts`'s audit kinds), update SPEC in the same PR or the gate fails.

### Workflow expectations

Read the relevant Issue, `docs/SPEC.md`, `docs/PLAN.md`, and any matching artifact under `docs/artifacts/` before implementing. Prefer small PRs that close one Issue or one cleanly split blocker. Reply in Japanese to the primary maintainer (per `AGENTS.md`).
