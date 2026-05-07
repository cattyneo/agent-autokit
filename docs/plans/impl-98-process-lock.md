# Issue 98: process-lock + .autokit/.lock + .gitignore

## Goal
Implement the Phase 2A cross-process run lock and `.autokit/.gitignore` enforcement without adding the serve API server.

## Context
- Issue: #98 `[v0.2 2A.1] process-lock + .autokit/.lock + .gitignore 強制`
- Blocked by: #97, closed on 2026-05-07
- SSOT:
  - `docs/spec/phase2-serve-dashboard.md` §1.2 / §1.2.1
  - `docs/spec/cross-cutting.md` §2.1 / §4
  - `docs/references/v0.2.0-issue-plan.md` Issue 2A.1 and implementation order step 11
  - `docs/SPEC.md` §3.2 / §4.1 / §4.3 / §10.2.2.1 / §11.5
- Node API evidence: Context7 `/nodejs/node` confirms `fs.mkdir` with `recursive:false` fails with `EEXIST` when the directory exists, and `fs.writeFileSync` `mode` only affects newly created files.

## Scope
- Add core `process-lock` API:
  - `tryAcquireRunLock(repo, options?)` fast-fail API.
  - `waitAcquireRunLock(repo, { timeout_ms })` bounded polling helper for tests/internal coordination.
  - Atomic `.autokit/.lock` directory acquisition, `holder.json.tmp` to `holder.json` publish, token-checked release.
  - missing/corrupt holder recovery after grace, stale PID recovery, wrong-token fail-closed behavior, host short/redacted field.
- Add `serve.lock.host_redact`, `serve.sse.max_connections`, `serve.sse.heartbeat_ms` config schema/defaults.
- Add `serve_lock_busy` to operational audit kinds and SPEC §10.2.2.1 / §13.4 as the Phase 2A.2 `autokit serve` HTTP 409 audit kind; CLI direct busy remains exit 75 + sanitized stderr only.
- Update `autokit init` to create `.autokit/.gitignore` with `*`, `!.gitignore`, `!config.yaml`.
- Update `doctor` to fail when `.autokit/.gitignore` is missing or contains extra unignore rules, and when existing `.autokit/.lock` / `holder.json` modes are not 0700/0600.
- Wrap existing write CLI commands `init`, `add`, `run`, `resume`, `retry`, `cleanup` with `tryAcquireRunLock`; busy exits 75 before state/worktree/PR mutation.

## Non-Scope
- `autokit serve`, HTTP 409 mapping, bearer/Host/Origin/Content-Type matrix, SSE, durable run records.
- `preset apply` locking and `.agents` invariant fixtures.
- New `failure.code`.
- Existing `.autokit/lock` force-unlock implementation beyond preserving current docs/behavior.

## Test Plan
- RED first:
  - `packages/core/src/process-lock.test.ts`: acquire/release, double acquire busy, wrong-token release, missing/corrupt holder recovery, stale replacement fail-closed, 3-process split-brain fixture, wait timeout, mode 0700/0600, host short/redacted, live PID with mismatched lstart not recovered.
  - `packages/core/src/config.test.ts`: `serve` defaults and override parsing.
  - `packages/core/src/logger.test.ts`: operational kind count and SPEC sync with `serve_lock_busy`.
  - `packages/cli/src/index.test.ts`: init writes `.autokit/.gitignore`; doctor fails when missing/wrong/extra-unignore and bad lock modes; lock busy for add/run/resume/retry/cleanup exits 75 before state interpretation and does not mutate tasks or dispatch workflow; release failure and invalid config host redaction are observable.
- Then GREEN with the smallest core/CLI changes.
- Required gates before PR:
  - `npx --yes bun@1.3.13 test packages/core/src/process-lock.test.ts packages/core/src/config.test.ts packages/core/src/logger.test.ts packages/cli/src/index.test.ts`
  - `bash scripts/check-trace.sh`
  - `npx --yes bun@1.3.13 run lint`
  - `npx --yes bun@1.3.13 run typecheck`
  - `npx --yes bun@1.3.13 test`
  - `npx --yes bun@1.3.13 run build`
  - `PATH="/Users/ntaka/.npm/_npx/b22965130bfded9d/node_modules/.bin:$PATH" /bin/bash scripts/check-assets-hygiene.sh`

## Implementation Steps
- [x] Add failing core process-lock tests and config/logger/CLI tests.
- [x] Implement `packages/core/src/process-lock.ts` and export it from core.
- [x] Add `serve` config schema/defaults and serialization coverage.
- [x] Add `.autokit/.gitignore` creation in init and doctor validation.
- [x] Add lock guard helper around write CLI commands with sanitized busy output and exit 75.
- [x] Sync SPEC/logger audit kind tables and run trace check.
- [x] Run targeted checks, full gates, self-review, PR.
- [ ] Review-fix findings, rerun gates, and merge PR.

## Risks / Stop Conditions
- Stop if stale PID/lstart behavior cannot be verified without unsafe process assumptions.
- Stop if write CLI lock wrapping would require changing public command semantics beyond exit 75 busy handling.
- Stop if SPEC §4.3 legacy `.autokit/lock` and new `.autokit/.lock` contracts conflict in a way that cannot be documented locally.
