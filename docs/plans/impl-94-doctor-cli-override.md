# Issue #94 implementation plan: doctor + CLI phase override

## Goal

Implement Issue #94 `[v0.2 1.8] doctor 拡張 + CLI override 安全 fail-closed`.

## Observable success criteria

- `autokit run --phase <agent_phase> --provider <provider> [--effort <effort>]` validates against the core capability/effort SoT before workflow dispatch.
- Valid override persists `runtime.phase_override` with a one-run `expires_at_run_id`, emits `phase_override_started`, affects only the selected phase, and is cleared at run end with `phase_override_ended`.
- Invalid phase/provider/effort, `ci_wait`/`merge`, and ambiguous provider/effort without `--phase` fail closed before runner dispatch.
- Provider override does not change the phase-fixed `permission_profile`.
- `autokit doctor` detects stale persisted `runtime.phase_override`, invalid config provider/effort, deprecated Claude `allowed_tools` warnings, and fail-closed permission relaxation.
- `autokit config show --matrix` renders the effective phase/provider/effort/permission matrix from core config/capability.

## Key constraints

- SSOT priority: `docs/spec/*.md`, then `docs/references/v0.2.0-issue-plan.md`, then live Issue #94, then frozen `docs/SPEC.md` / `docs/PLAN.md`.
- Scope excludes `autokit logs` / `autokit diff` (#97 / 1.10) and review/CI loop E2E (#95 / 1.9).
- No live provider/API-key-backed runs.
- Do not add new failure codes or SPEC trace owner changes in this PR.
- Keep `permission_profile` derived from core capability table only; CLI override must not expose permission changes.

## Relevant skills/tools

- `agent-autokit-issue-train`
- `issue-implementation`
- `general-review` after PR creation
- `review-fix` for valid findings
- `npx --yes bun@1.3.13` for Bun commands

## SSOT references

- `docs/references/v0.2.0-issue-plan.md` Issue 1.8
- `docs/spec/phase1-core-cli-runner.md` §2 / §6 / §8
- `docs/spec/cross-cutting.md` §2.1 / §3
- GitHub Issue #94
- Frozen reference: `docs/SPEC.md` §4.2 / §5.1 / §10.2.2.1

## Execution steps

1. [x] Add RED CLI/executor tests for valid override, invalid override, stale doctor detection, permission profile invariance, and config matrix output.
2. [x] Add a typed CLI `validatePhaseOverride()` helper using core capability/effort SoT.
3. [x] Wire `autokit run --phase/--provider/--effort` into production workflow options.
4. [x] Persist one-run `runtime.phase_override`, emit start/end audit events, and clear it at run end.
5. [x] Extend doctor with stale override detection while preserving existing config/env/prompt checks.
6. [x] Add `autokit config show --matrix`.
7. [x] Run targeted tests, then required gates.

## Validation plan

- Targeted:
  - `npx --yes bun@1.3.13 test packages/cli/src/index.test.ts packages/cli/src/executor.test.ts packages/workflows/src/index.test.ts`
- Required:
  - `npx --yes bun@1.3.13 run lint`
  - `npx --yes bun@1.3.13 run typecheck`
  - `npx --yes bun@1.3.13 run build`
  - `npx --yes bun@1.3.13 test`
- `bash scripts/check-trace.sh` only if failure codes/audit SPEC trace is touched. This plan does not require SPEC changes.
