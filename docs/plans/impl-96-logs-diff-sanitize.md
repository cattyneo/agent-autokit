# Issue #96 Implementation Plan: logs / diff sanitize

## 1. Purpose

Issue #96 closes the Phase 1 CLI surface for safe operator inspection. `autokit logs --issue N` must render rotated audit logs after a second sanitize pass, and `autokit diff --issue N` must render working tree diffs through path-based hunk removal plus content redaction.

## 2. Context

- Issue: `#96` `[v0.2 1.10] logs / diff sanitize / blacklist hunk 除去`
- Summary: add CLI `logs` and `diff` commands that consume the existing core redaction API without introducing new audit kinds or SPEC updates.
- Related SPEC / TEST:
  - `docs/references/v0.2.0-issue-plan.md` Issue 1.10
  - `docs/spec/phase1-core-cli-runner.md` §8 / §9.1 / §9.2
  - `docs/SPEC.md` §4.6.2.2 / §10.2
  - `docs/PLAN.md` logger / sanitizer gates as v0.1 reference
- Related code:
  - `packages/core/src/redaction.ts`
  - `packages/core/src/index.ts`
  - `packages/cli/src/index.ts`
  - `packages/cli/src/index.test.ts`
  - new `packages/cli/src/diff.ts`
- Operations rules:
  - `AGENTS.md`
  - `CLAUDE.md`

## 3. Scope

- Add `autokit logs --issue <n>` to read `.autokit/logs/*.log` in chronological file order, filter issue-scoped log entries when possible, and render sanitized JSONL/text.
- Add `autokit diff --issue <n>` as the Issue-scoped CLI surface for the current repo working tree diff; `--issue` is required for command consistency and future serve parity.
- Add a CLI-owned diff redactor/parser that:
  - replaces hunks for blacklist paths with `[REDACTED hunk: <path>]`
  - applies `sanitizeLogString` to all remaining diff content
  - preserves placeholders and sanitized lines without silent drops
- Add focused tests for logs sanitize, rotated log ordering, diff hunk removal, and content redaction.

## 4. Non-Scope

- No new audit kind.
- No `docs/SPEC.md` / `docs/PLAN.md` / `packages/core/src/logger.ts` audit table update.
- No `autokit serve` / SSE implementation; Phase 2A.4 owns that surface.
- No live provider subprocess or API-key-backed run.
- No changes to runner effort, provider resume, workflow state transitions, or trace gate semantics.

## 5. Test Scenarios

- Main path: multiple `.autokit/logs/*.log` files are joined by mtime/name order and rendered after `sanitizeLogString`.
- Security: bearer tokens, `sk-*`, GitHub PATs, and credentials JSON are not present in `logs` output.
- Security: `.env*`, `.codex/**`, `.claude/credentials*`, `id_rsa*`, `*.pem`, and `*.key` diff hunks are replaced with placeholders and raw lines are absent.
- Security: non-blacklist paths containing token-like content still render with `<REDACTED>`.
- Regression: existing CLI commands and config/init tests remain green.

## 6. Acceptance Criteria

- `AC-01`: `autokit logs --issue N` output excludes bearer/API key/credentials literals and keeps useful context.
- `AC-02`: log files are merged in chronological file order before rendering.
- `AC-03`: `autokit diff --issue N` replaces blacklisted path hunks with `[REDACTED hunk: <path>]`.
- `AC-04`: `autokit diff --issue N` applies `sanitizeLogString` to all remaining diff body.
- `AC-05`: output includes both a blacklist placeholder and content-redacted lines when both exist.
- `AC-06`: no new audit kind or SPEC/logger trace update is introduced.

## 7. Dependencies

- Native blocked-by: #94 closed.
- #87-#95 are already closed on GitHub.
- Existing core `sanitizeLogString` public export is available.
- No external API or library behavior needs live documentation lookup.

## 8. Related Documents (SSOT)

- 1st: `docs/spec/phase1-core-cli-runner.md` §8 / §9
- 2nd: `docs/references/v0.2.0-issue-plan.md` Issue 1.10
- 3rd: live GitHub Issue #96
- 4th: `docs/SPEC.md` §4.6.2.2 / §10.2 and `docs/PLAN.md` v0.1 references

## 9. Related Skills

- `agent-autokit-issue-train`
- `issue-implementation`
- `general-review`
- `review-fix` if valid findings appear

## 10. Implementation Steps

0. Confirm open PR / blocked-by / worktree state.
1. Create Issue #96 worktree from `origin/main`.
2. Write RED tests in `packages/cli/src/index.test.ts` and a focused `packages/cli/src/diff.test.ts`.
3. Implement CLI command parsing and helper functions in `packages/cli/src/index.ts`.
4. Implement diff redaction in `packages/cli/src/diff.ts`.
5. Run targeted tests, then lint/typecheck/test/build and relevant gates.
6. Open PR with #96 scope and evidence.
7. Run `general-review`, fix valid findings, revalidate, update PR, merge when checks are green.

## 11. Open Questions

- None. The maintainer selected option A: keep #96 scope and do not add a new audit kind.
