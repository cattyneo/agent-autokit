# Issue #102 Phase 2A E2E gate

## Goal
Add the Phase 2A required E2E gate that observes the merged 2A.1-2A.4 contracts together in fixture repositories: process lock, serve API/auth hardening, SSE replay/redaction, and assets hygiene.

## Observable Success Criteria
- A new required E2E fixture covers the integration chain from `tryAcquireRunLock` to `POST /api/run` `409 serve_lock_busy`, SSE authenticated connection, `Last-Event-ID` replay, and redaction of bearer/API key/credential/prompt data literals.
- API-running versus CLI-running bidirectional lock behavior is observable: API-held lock makes `autokit run` exit `75`; CLI-held lock makes `POST /api/run` return `409` without mutating `tasks.yaml`.
- Host / Origin / Content-Type / bearer fixtures are exercised at the Phase 2A gate level without weakening the detailed unit tests owned by #98-#101.
- Process-lock split-brain, `.autokit/.gitignore` doctor failure, config defaults/overrides, run-record resume recovery, and logs/diff bounds remain covered by the gate or by directly referenced required checks.
- Required validation includes targeted E2E first, then lint, typecheck, full test, build, and assets hygiene.

## Scope
- `e2e/runners/phase2a-gate.test.ts`: Phase 2A gate tests using fake workflow runners and in-process HTTP/SSE clients.
- Minor production fixes only if the E2E exposes a contract gap in #98-#101 behavior.
- This PR may update this plan with final validation evidence.

## Non-goals
- No `autokit preset apply` exclusion/integration; that remains Phase 3 / P3-E2E owner.
- No live Claude/Codex provider subprocess or API-key-backed run.
- No Dashboard UI / Phase 2B implementation.
- No new failure.code or audit kind unless a verified blocker appears. `serve_lock_busy` and `sse_write_failed` already belong to prior child issues.

## Constraints
- Keep one child Issue to one PR and avoid changing adjacent owner implementation unless the new gate proves a regression.
- Use fake `WorkflowRunner` / serve workflow seams; provider-backed tests are not run.
- Avoid duplicating every unit-level matrix case. The E2E should connect representative Phase 2A contracts and leave exhaustive child-owner matrices in their existing tests.
- Preserve v0.1 frozen references in `docs/SPEC.md` and `docs/PLAN.md`; #102 is a gate, not a schema feature.

## Execution Steps
- [x] Add RED E2E for API-held lock -> CLI tempfail -> keyless API retry 409 -> SSE replay/redact.
- [x] Add RED E2E for CLI-held lock -> API 409 with unchanged `tasks.yaml`, and cover auth/Host/Origin/Content-Type representative matrix.
- [x] Add RED E2E for process-lock split-brain + init/doctor `.gitignore` gate + config override/heartbeat where not already in the integration chain.
- [x] Implement only missing behavior needed to pass the gate. No production code changes were needed; the merged 2A.1-2A.4 behavior already satisfied the new gate.
- [x] Run targeted tests, then required gates. PR/review/merge loop remains next.

## Validation Plan
- `npx --yes bun@1.3.13 install --frozen-lockfile` -> exit 0.
- `npx --yes bun@1.3.13 run typecheck` -> exit 0. This also generated workspace `dist` for source tests that import package exports in a fresh worktree.
- `npx --yes bun@1.3.13 test e2e/runners/phase2a-gate.test.ts` -> exit 0, 3 pass.
- `npx --yes bun@1.3.13 test e2e/runners/phase2a-gate.test.ts packages/serve/src/index.test.ts packages/cli/src/index.test.ts packages/core/src/process-lock.test.ts` -> exit 0, 76 pass.
- `npx --yes bun@1.3.13 run lint` -> exit 0, with existing unrelated Biome warnings/infos in `e2e/runners/spike-runner-stability.ts` and `guides/index.html`.
- `npx --yes bun@1.3.13 run typecheck` -> exit 0.
- `npx --yes bun@1.3.13 test` -> exit 0, 452 pass.
- `npx --yes bun@1.3.13 run build` -> exit 0.
- `bash scripts/check-trace.sh` -> exit 0, `traceability checks passed`.
- `PATH=<temp bun wrapper> /bin/bash scripts/check-assets-hygiene.sh` -> exit 0, `assets hygiene passed`.

## SSOT
- GitHub Issue #102.
- `docs/spec/phase2-serve-dashboard.md` Phase 2A completion conditions and §1.1-§1.5.
- `docs/references/v0.2.0-issue-plan.md` Issue P2A-E2E and implementation order.
- `docs/SPEC.md` / `docs/PLAN.md` v0.1 frozen references for state, lock, logs, and hygiene invariants.
