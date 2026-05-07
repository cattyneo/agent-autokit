# Issue #99 serve API server

## Goal
Implement the Phase 2A `autokit serve` HTTP/JSON API in a new `packages/serve` package, with bearer/Host gates, run lock fast-path 409, durable run records, and CLI bundle smoke coverage.

## Observable Success Criteria
- `packages/serve` builds as a source package and is bundled into `packages/cli/dist/bin.js` without unresolved workspace imports.
- All documented `GET /api/tasks*`, `POST /api/{run,resume,retry,cleanup}`, and `GET /api/events` routes enforce bearer and Host before route-specific path resolution.
- Mutating endpoints strict-validate JSON payloads, fail closed when provider API key env vars are exported, create durable run records before `202`, preserve idempotency before lock acquisition, and map lock contention to `409 { code: "serve_lock_busy" }` without writing `tasks.yaml`.
- Logs/diff endpoints return sanitized bounded payloads with `truncated` / `next_cursor`, and reject client `max_bytes` above the server hard maximum with 413.
- `node packages/cli/dist/bin.js serve` starts on `127.0.0.1` and packed CLI hygiene remains green.

## Constraints
- SSOT: `docs/spec/phase2-serve-dashboard.md` §1.1 / §1.1.1 / §1.1.2 / §1.2 and `docs/references/v0.2.0-issue-plan.md` Issue 2A.2.
- Non-goals: Origin hardening, detailed Host normalization, Content-Type matrix hardening, token mode/umask fixture hardening, SSE event replay/redaction, Dashboard UI.
- Do not run live provider workflows. Tests must inject fake workflow execution.
- Keep package dependency direction acyclic: `cli -> serve -> core`; serve must not import CLI.
- No new `failure.code` or audit kind; `serve_lock_busy` trace was added in #98.

## Relevant Skills / Tools
- `agent-autokit-issue-train`, `issue-implementation`, `plan-writing`.
- Context7 checked Node `node:http` server/request/response behavior for this issue.
- Local `gh`, `bun@1.3.13`, `scripts/check-assets-hygiene.sh`.

## Execution Steps
- [ ] Add RED tests for serve auth/resource-oracle, strict payloads, idempotency, lock contention, API-key preflight, run records, bounded logs/diff, token lifecycle, and SSE smoke.
- [ ] Add `packages/serve` package and public `startAutokitServe()` API with injected workflow/diff/test seams.
- [ ] Move or share production API-key preflight and diff redaction through core so CLI and serve use the same contracts.
- [ ] Wire `autokit serve` in CLI, passing `runProductionWorkflow` as the workflow executor and avoiding live provider calls in tests.
- [ ] Update workspace/package/tsconfig references and build metadata.
- [ ] Run targeted tests first, then lint/typecheck/full test/build and assets hygiene before PR.

## Stop Conditions
- If endpoint response contracts require a data shape not inferable from SSOT or existing `TaskEntry`.
- If implementing crash recovery or SSE replay fully would exceed #99 and duplicate #101/#100 ownership.
- If live provider-backed execution is needed to verify the coordinator.
