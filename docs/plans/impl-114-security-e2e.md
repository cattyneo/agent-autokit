# Issue #114 Implementation Plan: Security E2E Cross-Cutting Gate

## Goal

Add the Phase E.3 security E2E gate for v0.2.0 so bearer auth, Host/Origin normalization, SSE/diff redaction, preset fail-closed categories, write_path_guard denial, and failure/audit message redaction are covered by active tests.

## Observable Success Criteria

- `e2e/security/*.test.ts` is discovered by `bun test` without `test.todo` or `describe.skip`.
- Security fixtures assert no raw bearer token, API key, auth path, private key marker, attacker filename, `$HOME`, or repo-root literal leaks in the covered outputs.
- Existing behavior remains unchanged for functional E2E owners (#112/#113); this PR only adds security matrix coverage and narrowly fixes security holes exposed by that matrix if needed.
- Required gates pass before handoff: lint, typecheck, test, build, and trace only if failure/audit trace tables are touched.

## Key Constraints

- SSOT priority: `docs/spec/*.md`, then `docs/references/v0.2.0-issue-plan.md` Issue E.3, then live Issue #114, then frozen `docs/SPEC.md` and `docs/PLAN.md`.
- No live Claude/Codex/provider subprocess or API-key-backed run; use fake workflow runner / direct test seams.
- Do not introduce new failure codes or audit kinds in #114.
- Do not expand into #115 backwards compatibility, #116 assets-hygiene, or #117 trace exactness.
- Root checkout has user-dirty `AGENTS.md`; all edits stay in this worktree.

## Scope

- Add `e2e/security/cross-cutting.test.ts` or similarly scoped active tests.
- Reuse existing local seams:
  - `startAutokitServe` for bearer, Host/Origin, token mode, reuse, and SSE redaction.
  - `runCli` for `autokit diff`, `autokit init`, and `autokit preset apply`.
  - `validateClaudeToolUseInput` for write_path_guard write denial.
  - Core/workflow helpers only if failure.message redaction requires stateful failure generation.
- Add local helper functions inside the E2E test file unless reuse is already exported.

## Non-Scope

- New provider runner behavior.
- New public redaction API breadth beyond existing exports.
- Full legacy yaml compatibility matrix.
- Assets package hygiene close gate.
- SPEC trace set exactness.

## Test Scenarios

1. Bearer / Host / Origin / token storage:
   - Missing bearer, query/cookie/form token, and stale previous token return 401.
   - Equal-length wrong bearer is rejected.
   - Same-origin, missing Origin, trailing-dot Host, uppercase Host, and `[::1]` Host are accepted.
   - Evil Origin and literal `Origin: null` are rejected.
   - Token file mode is `0600` and parent dir mode is `0700` under umask `022`, `027`, and `077`.
2. SSE redaction:
   - Runner stdout event with bearer, API keys, auth file paths, Claude credential path, and prompt_contract data emits only sanitized payload.
3. Diff / preset security:
   - `autokit diff` redacts credential-path hunks and non-blacklisted token/private-key content.
   - `preset apply` fails closed for basename/path blacklist, content signature, and `.agents` parent chain symlink, with category-only output and no task mutation.
4. write_path_guard:
   - Write profile denies `.env`, `.codex/auth.json`, `.claude/credentials.json`, `id_rsa`, `*.pem`, and `*.key`.
5. New failure redaction cross-check:
   - `effort_unsupported` message is sanitized for `$HOME` / repo root while preserving allowed `(effort, provider, model)` context.
   - `preset_path_traversal` stderr/audit details expose category only, not attacker filename.
   - `preset_blacklist_hit` stderr/audit details expose category only, not literal secret path/pattern.

## Dependencies

- Native blocked-by for #114 are #97, #102, #106; all are closed in the live GraphQL dependency fetch on 2026-05-08 JST.
- Existing E2E gates #112 and #113 are closed; #114 is the lowest ready open child by issue-plan order.

## References

- Issue #114: `[v0.2 E.3] セキュリティ E2E (横断)`
- `docs/references/v0.2.0-issue-plan.md` Issue E.3
- `docs/spec/cross-cutting.md` §1.1, §2, §4
- `docs/spec/phase2-serve-dashboard.md` §1.3, §1.3.1, §1.4
- `docs/spec/phase3-preset.md` §3.4.1
- `docs/SPEC.md` §4.6.2, §10.2, §11.4.3, §13.4

## Execution Steps

1. Add RED E2E tests under `e2e/security`.
2. Run the new test file and confirm the expected missing/failed security gate.
3. Implement the smallest security fixes exposed by the tests, if any.
4. Run targeted tests: new E2E file plus directly touched unit tests.
5. Run full required gates and update PR evidence.
