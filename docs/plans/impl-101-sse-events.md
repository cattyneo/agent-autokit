# Issue #101 SSE events

## Goal
Implement `GET /api/events` as the Phase 2A.4 SSE stream with typed event kinds, shared redaction, bounded replay, heartbeat, and connection safety.

## Success Criteria
- `GET /api/events` requires the #100 bearer / Host / Origin gates and returns SSE headers: `text/event-stream; charset=utf-8`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache, no-transform`.
- The only emitted SSE event kinds are `task_state`, `phase_started`, `phase_finished`, `audit`, `runner_stdout`, `heartbeat`, and `error`.
- Every non-heartbeat/error payload is redacted before write: bearer token, provider API key values, credential-shaped JSON, prompt contract `data`, and diff-like payloads.
- Reconnect with `Last-Event-ID` replays events still present in the N=64 ring buffer; stale IDs receive a fixed-message `error` event.
- Heartbeat uses `config.serve.sse.heartbeat_ms`; max connections uses `config.serve.sse.max_connections`; overflow is 503.
- Backpressure is observable as an `error` event with `code="backpressure"` when possible, then the stream closes.

## Scope
- `packages/serve/src/index.ts`: SSE hub, typed event API, frame serialization, ring buffer, heartbeat, replay, redaction, and workflow/audit emission seams.
- `packages/serve/src/index.test.ts`: RED tests for headers, event closed list, redaction, runner stdout debug gating, replay, stale replay, heartbeat, connection limit, and backpressure.
- `docs/SPEC.md`: add the SSE event closed list and frame contract under §10.2.
- This PR does not add logger audit kinds. SSE event kinds are a serve stream schema, not `logger.ts` audit kinds.

## Tasks
- [x] Add tests that fail on the current smoke-only SSE implementation.
- [x] Implement a small in-process SSE hub with N=64 replay and connection accounting.
- [x] Wire audit, task state, phase, and runner stdout publish points without changing workflow ownership.
- [x] Apply redaction recursively before every event frame and keep `runner_stdout` debug-only.
- [x] Update SPEC §10.2 and keep Issue #101 scope separate from P2A-E2E #102.
- [x] Run targeted serve/core checks first, then required gates.

## Validation
- `npx --yes bun@1.3.13 test packages/serve/src/index.test.ts` -> exit 0, 21 pass.
- `npx --yes bun@1.3.13 test packages/serve/src/index.test.ts packages/cli/src/index.test.ts` -> exit 0, 61 pass.
- `npx --yes bun@1.3.13 run typecheck` -> exit 0.
- `npx --yes bun@1.3.13 run lint` -> exit 0, with existing unrelated Biome warnings/infos in `e2e/runners/spike-runner-stability.ts` and `guides/index.html`.
- `npx --yes bun@1.3.13 test` -> exit 0, 445 pass.
- `npx --yes bun@1.3.13 run build` -> exit 0.
- `bash scripts/check-trace.sh` -> exit 0.
- `PATH=<temp bun wrapper> /bin/bash scripts/check-assets-hygiene.sh` -> exit 0, `assets hygiene passed`.

## SSOT
- GitHub Issue #101.
- `docs/spec/phase2-serve-dashboard.md` §1.4 / §1.4.1-§1.4.4.
- `docs/references/v0.2.0-issue-plan.md` Issue 2A.4 and implementation order step 11c.
- `docs/SPEC.md` §10.2 and §11.1.1.
- Node.js official HTTP docs: `ServerResponse.write()` returns `false` on queued backpressure and emits `drain` later.
