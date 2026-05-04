# Codex exec migration review evidence

確認日: 2026-05-05 (Asia/Tokyo)

対象: MIG-006 / Issue #37

## Scope

- Review tool: `claude -p` with Claude.ai subscription auth.
- Review mode: `general-review` requested, review-only.
- Inputs: `docs/SPEC.md`, `docs/PLAN.md`, `docs/codex_exec_migration_plan.md`, `docs/spike-results.md`, and current Issue #23 / #10 / #11 / #44 policy summaries.
- Claude tools: disabled for the successful run. A prior Read/Grep-only attempt was interrupted after it produced no stdout/stderr for more than two minutes and is not used as pass evidence.
- Prohibited actions: no Claude git / gh / PR / merge / edit operation.

Preflight:

```text
claude --version: 2.1.126 (Claude Code)
claude auth status: loggedIn=true, authMethod=claude.ai, apiProvider=firstParty, subscriptionType=max
env | rg '^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY)=': no matches
ANTHROPIC_API_KEY use: not used
```

Run:

```text
Command shape: claude -p --output-format json --tools "" --setting-sources project <review-prompt>
Result: passed
session_id: 3dddf88c-dcd1-42fe-88ef-bcd4ba23d2c7
stderr: empty
cost_usd telemetry: 0.6031059999999999
```

`cost_usd` is CLI telemetry from the Claude output and is not proof of actual account billing under subscription auth.

## Verdict

Pass with minor cleanups. Claude reported no blocker or major findings. The review found the migration state mutually consistent on the critical axes:

- Codex SDK is deferred / paid-risk-gated, not v0.1.0 primary.
- API-key-backed paths are fail-closed or require explicit approval.
- AK-009 depends on #23 A (Claude CLI) only.
- AK-010 depends on #23 B (`codex exec`) plus MIG-004 pinned evidence.
- Claude is review-only and is not assigned git / gh / PR / merge actions.

Claude concluded that #38 can proceed to final pre-resume review.

## Findings

### Blocker

- None.

### Major

- None.

### Minor

1. `docs/spike-results.md` kept deferred Codex SDK live smoke output inline. It was already marked deferred, but the review recommended adding an explicit "do not use as AK-009 / AK-010 adoption evidence" banner.
   - Resolution: added the banner in `docs/spike-results.md`.
2. `docs/PLAN.md` AK-009 / AK-010 table rows referenced migration parent #31 completion but did not explicitly mirror Issue #10 / #11's #38 final consistency review blocker.
   - Resolution: added #38 final consistency review to both rows.
3. `docs/SPEC.md` §9.1.1 A/B headings could be read in isolation as AK-001 close requirements rather than #23 adoption gates.
   - Resolution: annotated A as #23 A and B as #23 B.
4. Codex CLI version pin traceability in SPEC / PLAN could be more explicit.
   - Resolution: SPEC §9.1.1 B now names Codex CLI 0.128.0 and points to `docs/spike-results.md`.

## Resume Impact

Implementation remains blocked until #38 completes. After #38, AK-009 / AK-010 can be resumed only under the split gates recorded in #23:

- AK-009: Claude CLI #23 A gate only.
- AK-010: Codex exec #23 B gate plus MIG-004 pinned evidence.
- Codex SDK / Claude Agent SDK: deferred #44, not v0.1.0 blockers.

