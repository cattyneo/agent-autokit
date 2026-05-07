# Issue #108: bundled skill prompt_contract alignment

## Goal
Align `autokit-implement` and `autokit-review` bundled skills with the v0.2 prompt_contract and runner visibility gates without changing prompt schemas, `autokit-question`, or agents.

## Success Criteria
- `packages/cli/assets/skills/autokit-implement/SKILL.md` documents TDD / scoped implementation / docs delegation and the `implement` + `fix` prompt_contract data fields.
- `packages/cli/assets/skills/autokit-review/SKILL.md` documents review axes, read-only review behavior, supervisor handoff, and the `review` prompt_contract finding fields.
- `CONTRIBUTING.md` records upstream sync duties for the two copied/adapted skill sources.
- `docs/SPEC.md` §8.3 records the copy-source pin: `tdd-workflow` commit hash and, per operator decision A, `general-review` local source fingerprint.
- Runner visibility and prompt schema snapshot gates remain green, with no `test.todo` / `describe.skip` added.

## Constraints
- In scope: the two base skill assets, `CONTRIBUTING.md`, SPEC §8.3, focused tests, and this plan.
- Out of scope: `autokit-question`, bundled agents, preset-specific skill overrides, prompt structured-output schema changes, live provider calls, new failure codes, and new audit kinds.
- `general-review` has no verifiable upstream commit in the local installation; operator selected option A, so this PR pins its local `SKILL.md` SHA-256 instead of inventing a commit.

## SSOT
- GitHub Issue #108.
- `docs/references/v0.2.0-issue-plan.md` Issue 4.2.
- `docs/spec/phase4-quality.md` §1.1 / §1.2.
- `docs/SPEC.md` §8.3 / §9.3 / §9.4.
- `docs/PLAN.md` §1 and important principles 7-8.

## Tasks
- [x] Add a focused skill asset quality gate to `e2e/runners/runner-visibility.ts` and RED-check it against current minimal skills.
- [x] Update `autokit-implement` and `autokit-review` base skill assets to include source pins, phase scope, safety boundaries, and prompt_contract field obligations.
- [x] Update runtime-installable preset skill overrides so they cannot replace the base skills with stale weaker contracts.
- [x] Add `CONTRIBUTING.md` upstream sync note and SPEC §8.3 source pin note.
- [x] Run focused gates: runner visibility, runner-contract snapshot, codex-runner schema snapshot.
- [x] Address general-review findings: core-only git mutation wording, `data.findings` wording, source fingerprint SSOT exception, real bundled skill fixture coverage, and preset override coverage.
- [x] Run required handoff gates: lint, typecheck, full test, build, assets hygiene.
