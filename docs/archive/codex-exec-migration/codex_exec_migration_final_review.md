# Codex exec migration final review

確認日: 2026-05-05 (Asia/Tokyo)

対象: MIG-007 / Issue #38

## Verdict

**Codex exec primary で migration train は完了可能。**

未解消 blocker はない。AK-009 / AK-010 の本実装を直接始める前に、次の作業は **Issue #23 primary runner adoption matrix evidence** を A/B gate として処理すること:

- #23 A: AK-009 用 Claude CLI (`claude -p`) adoption gate。
- #23 B: AK-010 用 Codex CLI (`codex exec`) adoption gate。
- #44: Codex SDK / Claude Agent SDK の paid-risk-gated deferred matrix。v0.1.0 blocker ではない。

## Issue State

Migration train:

- #31: open parent; close after #38 merge / close.
- #32: closed.
- #33: closed.
- #34: closed.
- #35: closed.
- #36: closed.
- #37: closed.
- #38: this review.

Post-migration gates / implementation issues:

- #23: open, rewritten as primary runner adoption matrix evidence with A/B split.
- #10: open, AK-009 Claude CLI only; blocked by #23 A and #38.
- #11: open, AK-010 `codex exec` only; blocked by #23 B, MIG-004 evidence, and #38.
- #44: open deferred paid-risk-gated SDK matrix; not agent-ready and not v0.1.0 blocker.

## Mechanical Search Summary

Search targets:

```text
Codex SDK primary
runStreamed
resumeThread
Codex SDK runner
@openai/codex-sdk
codex_thread_id
CODEX_API_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY
auth.json
resume --last
#23 A / #23 B
```

Results:

- `Codex SDK primary` remains only as migration history / "not primary" context.
- `runStreamed` / `resumeThread` remain only inside deferred SDK reference / migration search instructions, explicitly not adoption evidence.
- `@openai/codex-sdk` remains only in deferred reference and #44 context.
- API key env names appear in fail-closed, unset-required, sanitize, or explicit-approval contexts.
- `~/.codex/auth.json` / `$CODEX_HOME/auth.json` are documented as password-equivalent and excluded from logs / artifacts / issue / PR comments.
- `resume --last` is documented as isolated cwd / operator debug only; production resume uses stored `thread_id`.
- #23 A / #23 B are present in SPEC / PLAN / review evidence.
- `codex_thread_id` is now resolved as a pre-GA draft old key. v0.1.0 uses clean-slate `provider_sessions.<phase>.codex_session_id` only; old draft task state is re-add / cleanup scope, not an alias requirement.

## AK-009 / AK-010 Resume Target

Implementation order after migration:

1. Execute #23 A/B adoption evidence gates only after subscription / billing handling or operator approval for high-count runs.
2. Start AK-009 (#10) only after #23 A is complete and all other blockers are closed.
3. Start AK-010 (#11) only after #23 B is complete, MIG-004 pinned evidence remains valid, and all other blockers are closed.

Do not start AK-001 through AK-020 feature implementation directly from this migration closeout. The first actionable non-migration item is #23, not AK-009 / AK-010 code.

## Residual Risks

- `codex exec` sandbox write-denial / workspace-write and explicit approval prompt behavior are not live-proven; AK-010 must keep these as implementation-time fail-closed fixtures / gates.
- High-count Claude / Codex matrix execution can consume subscription quota / paid entitlement; #23 requires explicit operator approval or billing handling confirmation.
- Deferred SDK evidence remains recorded for reference but is bannered as not adoption evidence.

## Close Decision

#38 can close after this document is merged. Parent #31 can close after #38 closes. At that point, the migration-only issue train (#32-#38) is complete and the repository is aligned to the `claude -p` + `codex exec` primary policy.

