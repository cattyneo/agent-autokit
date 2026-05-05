# MIG-001 Codex exec migration inventory

確認日: 2026-05-05 (Asia/Tokyo)

## Scope

This inventory closes the R0 / MIG-001 stop gate before rewriting SPEC, PLAN, Issue #23, AK-009, and AK-010.

Included:

- Identify remaining Codex SDK primary assumptions in SPEC / PLAN / Issues / spike evidence.
- Separate v0.1.0 content from deferred / paid-risk-gated SDK or high-count matrix work.
- Confirm the current stop gate for Issue #23, AK-009, and AK-010.
- Confirm that `packages/codex-runner` can keep its directory and package name while its scope changes to a `codex exec` CLI wrapper.

Excluded:

- SPEC / PLAN body rewrite. Owned by MIG-002 and MIG-003.
- `codex exec` live smoke or high-count matrix execution. Owned by MIG-004 and requires operator approval where noted.
- Issue #23 rewrite or replacement. Owned by MIG-005.
- AK-009 / AK-010 implementation.

## Current GitHub State

Source commands:

- `gh pr list --state open --limit 30 --json ...`
- `gh issue view 31`
- `gh issue view 32 33 34 35 36 37 38 23`
- `gh issue view 10`
- `gh issue view 11`
- `gh run list --limit 20 --json ...`

Observed state:

| Target | State | MIG-001 note |
| --- | --- | --- |
| Open PRs | none | No work-in-progress PR was present before starting MIG-001. |
| #31 | open | Parent migration train. Blocks AK-009 (#10) and AK-010 (#11) until all children are complete. |
| #32 | open | No blocked-by. First executable migration issue. |
| #33 | open | Blocked by #32. |
| #34 | open | Blocked by #33. |
| #35 | open | Blocked by #32; live one-shot smoke also requires operator approval and API key unset confirmation. |
| #36 | open | Blocked by #34 and #35. |
| #37 | open | Blocked by #33, #34, and #36. |
| #38 | open | Blocked by #35, #36, and #37. |
| #23 | open | Has a migration gate comment saying not to execute the current body as written; blocked by #36 for rewrite vs replacement. |
| AK-009 (#10) | open | Has a migration gate comment; intended post-migration scope is Claude CLI only. |
| AK-010 (#11) | open | Has a migration gate comment; intended post-migration scope is `codex exec` primary. |
| CI on latest main | success | Latest `main` runs for CI and Assets Hygiene on AK-008 merge were successful. |

Evidence references:

| Item | Observed reference |
| --- | --- |
| Repository | `cattyneo/agent-autokit` |
| Base head at inventory start | `a013d0fcb9e8bb640dd92091e97f09f271106b8a` |
| MIG-001 PR head | `88b860d8f0c5eb2e18714a5face4ea1e03c5a0ce` |
| Parent issue | https://github.com/cattyneo/agent-autokit/issues/31 |
| MIG-001 issue | https://github.com/cattyneo/agent-autokit/issues/32 |
| #23 stop-gate comment | https://github.com/cattyneo/agent-autokit/issues/23#issuecomment-4372671853 |
| AK-009 migration-gate comment | https://github.com/cattyneo/agent-autokit/issues/10#issuecomment-4372672018 |
| AK-010 migration-gate comment | https://github.com/cattyneo/agent-autokit/issues/11#issuecomment-4372672153 |
| Latest main CI run observed | https://github.com/cattyneo/agent-autokit/actions/runs/25315315070 |
| Latest main Assets Hygiene run observed | https://github.com/cattyneo/agent-autokit/actions/runs/25315315092 |

## Stop Gate Evidence

Issue #23 already has the required GitHub stop record:

- The existing body still describes `@openai/codex-sdk` / `runStreamed` / `resumeThread` full matrix evidence.
- A migration gate comment states the issue must not be executed as currently written.
- The same comment states that #36 will decide rewrite vs replacement and split AK-009 / AK-010 gates.
- The comment also states that no `OPENAI_API_KEY` / `CODEX_API_KEY` / `ANTHROPIC_API_KEY` execution is allowed without explicit operator approval.

AK-009 (#10) and AK-010 (#11) also have migration gate comments:

- AK-009 is blocked by #31 and should become Claude CLI (`claude -p`) only after migration.
- AK-010 is blocked by #31 and should become `codex exec` primary after migration.
- Both precise body / dependency rewrites are deferred to #36 and final resume approval is deferred to #38.

## Inventory: SPEC

Search terms:

- Old SDK terms: `Codex SDK`, `@openai/codex-sdk`, `runStreamed`, `resumeThread`, `codex_thread_id`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
- New CLI terms: `CODEX_API_KEY`, `codex exec`, `--json`, `--output-schema`, `--output-last-message`, `thread_id`, `session_id`

Observed old-primary or incomplete areas:

| Area | Current evidence | Migration owner |
| --- | --- | --- |
| Runtime summary | SPEC still states Codex is `Codex SDK (TS) primary` with `runStreamed` + `resumeThread`. | #33 |
| Directory description | `packages/codex-runner` is described as a Codex SDK wrapper. | #33 |
| `provider_sessions` shape | Codex phases use `codex_thread_id`. | #33, #34 |
| Resume text | Generic `session_id/thread_id` and SDK-style resume text remains. | #33 |
| Runner adoption criteria | Primary Codex runner is still the SDK N=20 gate. | #33 |
| API key policy | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are covered, but `CODEX_API_KEY` is not consistently covered. | #33 |
| Auth file hygiene | Claude/Codex subscription credential patterns exist, but Codex auth file handling needs explicit password-equivalent treatment across sanitize / artifact hygiene. | #33 |
| AC / traceability | API key rejection and runner env AC omit `CODEX_API_KEY` in several places. | #33, #34 |
| Future work | Codex SDK / Claude Agent SDK future positioning remains tied to old S0 wording. | #33 |

Items to keep in v0.1.0 after rewrite:

- Claude phases use `claude -p`.
- Codex phases use `codex exec` with ChatGPT-managed auth.
- Core retains git / gh / PR / merge ownership.
- Runner child env excludes API keys and GitHub tokens.
- `packages/codex-runner` directory and package name may remain.

Items to move to deferred / paid-risk-gated:

- Codex SDK primary adoption.
- `@openai/codex-sdk` N=20 full matrix.
- `runStreamed` / `resumeThread` as v0.1.0 required APIs.
- Claude Agent SDK full matrix.

## Inventory: PLAN

Observed old-primary or incomplete areas:

| Area | Current evidence | Migration owner |
| --- | --- | --- |
| MVP summary | Runner summary still says `claude -p primary + Codex SDK`. | #34 |
| Issue breakdown | AK-009 and AK-010 both still depend on AK-001-FU #23. | #34, #36 |
| AK-010 scope | Scope still reads generic `codex-runner` auth/runner/resume/sandbox rather than `codex exec` CLI subprocess contract. | #34 |
| File tree | `packages/codex-runner/src/runner.ts` and `resume.ts` are documented as `runStreamed` / `resumeThread`. | #34 |
| S0 gate | Primary Codex gate is still Codex SDK N=20. | #34 |
| Test strategy | `codex-runner` tests are still SDK mock oriented. | #34 |
| Traceability | `CODEX_API_KEY`, Codex auth file sanitize, CLI feature evidence, and auth mode fail-closed need traceability rows. | #34 |
| Risk table | Codex SDK sandbox / approval policy risk should become CLI exec subprocess / sandbox / approval risk, with SDK deferred. | #34 |

Items to keep in v0.1.0 after rewrite:

- AK-009 remains Claude runner implementation only.
- AK-010 remains Codex runner implementation but changes to `codex exec` CLI wrapper semantics.
- Workflow / core / TUI dependencies remain downstream of runner gates.
- `codex-runner` package name can remain as the implementation boundary.

Items to move to deferred / paid-risk-gated:

- Codex SDK runner adoption gate.
- Claude Agent SDK adoption gate.
- Any high-count matrix that can incur paid usage without explicit approval.

## Inventory: Issues

| Issue | Current risk | Required migration action |
| --- | --- | --- |
| #23 | Current body still requests old full matrix with Codex SDK. | #36 must rewrite or replace; current body must remain non-executable until then. |
| AK-009 (#10) | Body still lists #23 as full adoption evidence gate. | #36 must update dependency wording to Claude CLI evidence gate only; #38 decides resume. |
| AK-010 (#11) | Body still lists #23 as full adoption evidence gate and generic Codex runner scope. | #36 must update dependency wording to `codex exec` evidence gate; #38 decides resume. |
| #31 | Parent dependency map is correct for the migration train. | Keep as parent tracking issue. |
| #32 | No dependency; this inventory is the close artifact. | Close via PR after validation and issue comment. |
| #33-#38 | Dependencies are declared in #31 and issue bodies. | Execute only after blocked-by issues close. |

## Inventory: spike-results

Observed evidence split:

| Evidence | Current state | MIG-001 disposition |
| --- | --- | --- |
| Claude CLI docs/help/smoke | Present. `cost_usd` is already treated as CLI telemetry, not billing proof. | Keep for Claude CLI evidence; high-count matrix still requires billing/operator approval. |
| Claude Agent SDK TS | Present as experimental evidence. | Move out of v0.1.0 blocker path; paid-risk-gated/deferred if matrix is needed. |
| Codex CLI one-shot | Present for PATH CLI / npx CLI, including `codex exec --json` and `--output-schema` snippets. | Do not treat as complete AK-010 evidence until MIG-004 pins feature behavior and missing resume/final-output details. |
| Codex SDK one-shot | Present for `runStreamed` / `resumeThread`. | Keep only as deferred reference; do not use as `codex exec` adoption evidence. |
| Full matrix plan | Still points to #23 and Codex SDK. | Rewrite/split through #35 and #36. |

MIG-004 must still confirm or explicitly mark unsupported:

- Pinned Codex CLI version / path / checksum / install source.
- `codex exec --json` JSONL event stream and session id extraction.
- `codex exec resume <session_id>` and `resume --last`.
- `--output-schema`.
- `--output-last-message` / `-o`.
- Sandbox and approval fail-closed behavior.
- ChatGPT-managed auth with `OPENAI_API_KEY` / `CODEX_API_KEY` unset.

## Package / Directory Rename Decision

Current repository state includes `packages/codex-runner`.

MIG-001 decision:

- Do not require a directory or package rename.
- Keep `packages/codex-runner` as the implementation boundary.
- Rewrite descriptions and internal module responsibilities from SDK wrapper to `codex exec` CLI subprocess wrapper in #33 / #34.

Rationale:

- The package name describes ownership, not implementation transport.
- Renaming would broaden the migration and create avoidable import/package churn.
- #31 explicitly says not to rename `packages/codex-runner` unnecessarily.

## Safety Confirmation

No live provider matrix or API-key-backed execution was performed for this inventory.

MIG-001 only used:

- Git local state commands.
- GitHub issue / PR / Actions read commands.
- Documentation search with `rg`.
- Existing local file inspection.

The following were not run:

- `codex exec` live model calls.
- Codex SDK or Claude Agent SDK calls.
- Claude high-count matrix.
- Any command requiring `OPENAI_API_KEY`, `CODEX_API_KEY`, or `ANTHROPIC_API_KEY`.

## Handoff To Next Migration Issues

After #32 closes:

1. #33 may rewrite SPEC against this inventory and `docs/spec_plan_codex_exec_revision_instructions.md`.
   If #35 is still open, exact `codex exec` flags, session ID field, resume form, and final output retrieval must remain placeholder / stop-condition text.
2. #35 may run pinned `codex exec` evidence collection after confirming API keys are unset and operator-approved live smoke scope.
   API key present rejection must use dummy / sentinel env or mock / probe evidence before runner spawn, not real API-key-backed provider calls.
3. #34 must wait for #33, then update PLAN / AK dependency mapping.
4. #36 must wait for #34 and #35, then rewrite or replace #23 and split runner gates.
5. #37 and #38 must remain blocked until their declared dependencies close.
