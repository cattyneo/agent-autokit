# Issue #89 AgentRunInput effort/effective permission implementation plan

## Goal

Implement Issue #89 by extending the workflow-to-runner contract with resolved effort and capability-derived effective permissions, while preserving mock/fake-runner execution and keeping runner internal consumption out of scope.

## Observable success criteria

- `AgentRunInput.effort` and `AgentRunInput.effective_permission` are populated for all 7 agent phases.
- Workflow phase start resolves effort immediately before runner input construction, persists `runtime.resolved_effort`, and emits `effort_downgrade` audit from the workflow boundary.
- Unsupported effort/model/provider tuples fail with `failure.code=effort_unsupported` under `unsupported_policy=fail`, or downgrade one ladder step under `downgrade`.
- Public `sanitizeLogString` is exported from core and is used by logger and workflow state writes before persisting failure messages, findings, reject reasons, and reject history.
- `resumeForPhase` uses `phase_override.provider` > `provider_sessions.<phase>.last_provider` > effective config provider, and metadata persistence saves session id + `last_provider` without deleting the opposite provider session id.
- SPEC trace updates for `effort_unsupported` and `effort_downgrade` pass `bash scripts/check-trace.sh`.

## Key constraints

- Do not implement runner-specific consumption of effort flags or Claude/Codex runner rewrites; those are #90-#92.
- Do not run live provider subprocesses or API-key-backed workflows.
- Keep capability table as the provider/permission SoT.
- Failure/audit/state text must not persist raw API tokens, `$HOME` absolute paths, or repo-root absolute paths.

## Relevant skills/tools

- `issue-implementation`: plan-first, test-first implementation loop.
- `general-review` / `review-fix`: post-PR multi-lens review and valid-finding closure.
- Local checks: targeted `bun test`, then `lint`, `typecheck`, `bun test`, `build`, and `bash scripts/check-trace.sh`.

## Execution steps

- [x] Add RED tests for `AgentRunInput` effort/effective permission, effort fail/downgrade, timeout precedence, provider resume selection, metadata persistence, and redaction.
- [x] Complete `effort-resolver.ts` as a pure resolver returning resolved effort plus audit candidate/failure.
- [x] Add public `redaction.ts`, export it from core, and route logger/workflow state persistence through it.
- [x] Extend `AgentRunInput`, build effective permissions from capability table, and persist resolved effort before runner dispatch.
- [x] Update provider resume/persistence to use override/last_provider/config provider ordering.
- [x] Add `effort_unsupported` and `effort_downgrade` to code + SPEC trace tables.
- [x] Run targeted checks, required gates, and `check-trace.sh`.
- [ ] Create PR, run review, fix valid findings, merge.
