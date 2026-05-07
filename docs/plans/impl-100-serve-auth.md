# Issue #100 Serve Auth Hardening

## Goal
Harden `autokit serve` auth gates to match v0.2 Phase 2A.3: bearer-only token use, normalized Host allowlist, Origin 4-state handling, Content-Type 415 for mutating requests, and token mode/umask guarantees.

## Tasks
- [x] Add RED tests for bearer reuse / non-Authorization token presentation / token path isolation / mode 0600 + parent 0700 under umask 022, 027, 077 -> Verify with `packages/serve/src/index.test.ts`.
- [x] Add RED tests for Host matrix (`127.0.0.1`, `localhost`, `LOCALHOST`, `localhost.`, `[::1]`, outside host) and Origin matrix (missing, same-origin, foreign, `null`) -> Verify expected 200/403.
- [x] Add RED tests for mutating Content-Type 415 before body parse / dispatch -> Verify missing, `text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data` reject.
- [x] Add review-fix regression tests for `timingSafeEqual`, Host prefix/partial rejects, all mutating endpoint Content-Type rejects, `::1` bind rejection, token write failure cleanup, and CLI signal cleanup seam.
- [x] Implement auth gate normalization in `packages/serve/src/index.ts` without changing SSE replay/redaction scope -> Verify bearer/Host/Origin applies before route resolution.
- [x] Update `docs/SPEC.md` §11 with bearer / Host / Origin / Content-Type serve security contract -> Verify `bash scripts/check-trace.sh`.
- [x] Run targeted checks, then full gates and packed serve smoke -> Verify lint/typecheck/test/build/hygiene/trace all pass.

## Done When
- [x] #100 AC and live issue scope are covered by tests with no skipped/todo required-gate tests.
- [x] No live provider/API-key-backed workflow is run.
- [ ] PR body records SSOT references, commands/exit codes, CI status, provider-backed tests not run, and residual risks.

## Validation
- `npx --yes bun@1.3.13 test packages/serve/src/index.test.ts` -> exit 0, 14 pass.
- `npx --yes bun@1.3.13 test packages/serve/src/index.test.ts packages/cli/src/index.test.ts` -> exit 0, 54 pass.
- `npx --yes bun@1.3.13 run lint` -> exit 0 (existing Biome warnings/infos only).
- `npx --yes bun@1.3.13 run typecheck` -> exit 0.
- `npx --yes bun@1.3.13 test` -> exit 0, 438 pass.
- `npx --yes bun@1.3.13 run build` -> exit 0.
- `PATH=<temp bun wrapper> /bin/bash scripts/check-assets-hygiene.sh` -> exit 0.
- `bash scripts/check-trace.sh` -> exit 0.

## Notes
- Out of scope: SSE event replay/redaction/Last-Event-ID/heartbeat details owned by #101.
- Keep #99 operation/routing behavior stable while tightening request admission.
