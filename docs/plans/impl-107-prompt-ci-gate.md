# Issue #107 Implementation Plan: prompt CI gate

## Goal

Add the Phase 4.1 CI gates that freeze the Codex prompt-contract output schema and validate real bundled prompt assets against the required visibility markers and mapping table.

## Context

- Issue: #107 `[v0.2 4.1] prompt CI gate (snapshot + visibility)`
- Dependency: native `blockedBy` is #97 only; #97 is closed.
- Worktree/branch: `.agents/worktrees/issue-107-prompt-ci-gate` / `codex/issue-107-prompt-ci-gate`
- SSOT:
  - `docs/spec/phase4-quality.md` §1.3, §2.1
  - `docs/references/v0.2.0-issue-plan.md` Issue 4.1
  - `docs/SPEC.md` §9.3, §9.4 as v0.1 frozen invariants

## Scope

- Add a deterministic JSON snapshot test for `codexPromptContractJsonSchema` in `packages/codex-runner/src/index.test.ts`.
- Extend `e2e/runners/runner-visibility.test.ts` / `.ts` to read `packages/cli/assets/prompts/*.md`.
- Add the marker order gate for `## Result`, `## Evidence`, `## Changes`, `## Test results`.
- Add `e2e/fixtures/prompt-contract/mapping.md` and require every base prompt and bundled preset effective prompt to be represented.
- Normalize existing bundled prompt assets with the minimal marker sections needed for the gate.

## Non-Scope

- Adding the initial four bundled presets is #105.
- Rewriting `autokit-implement` / `autokit-review` skills is #108.
- Agent asset rewrites are #109.
- No live provider subprocess or API-key-backed run.
- No SPEC update is required for this Issue.

## Acceptance Criteria

- Codex schema snapshot fails on schema drift.
- Runner visibility gate reads real prompt assets, not only spike fixtures.
- Marker section missing or out of order fails.
- Prompt file / preset effective prompt mapping omissions fail.
- Existing `validatePromptContractPayload` tests keep all phases green.

## Test Scenarios

- Snapshot green for all 7 prompt contracts.
- Actual bundled prompts pass marker + mapping gate.
- Copied asset root with a missing marker fails.
- Copied asset root with an extra prompt file fails unless mapping and contract set are updated.
- Copied asset root with a bundled preset prompt override fails when mapping omits that effective prompt.

## Implementation Steps

1. Add RED tests for schema snapshot and prompt asset visibility failures.
2. Add the schema snapshot fixture.
3. Extend the runner visibility scanner to read actual assets and parse `mapping.md`.
4. Add minimal marker sections to current prompt assets.
5. Run focused tests first, then required gates.

## Validation Plan

- `npx --yes bun@1.3.13 test packages/codex-runner/src/index.test.ts e2e/runners/runner-visibility.test.ts packages/core/src/runner-contract.test.ts`
- `npx --yes bun@1.3.13 run lint`
- `npx --yes bun@1.3.13 run typecheck`
- `npx --yes bun@1.3.13 test`
- `npx --yes bun@1.3.13 run build`
- `/bin/bash scripts/check-assets-hygiene.sh` when assets changed, using the Bun wrapper if PATH lacks `bun`.
