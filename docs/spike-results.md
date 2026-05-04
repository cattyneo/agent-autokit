# S0 Runner / CLI Spike Results

確認日: 2026-05-04 / MIG-004 refresh: 2026-05-05 (Asia/Tokyo)

## Summary

AK-001 は S0 の不確実性を S1 前に潰すための spike。ここでは公式 docs / CLI help / npm package metadata / package type definitions / one-shot live smoke / prompt_contract fixture / full matrix 実行計画の結果を固定する。

Full N=20 adoption matrix は operator 明示承認後に follow-up #23 で実行済み。`claude -p` は subscription auth (`claude.ai`, subscription type `max`) で実行でき、plan / plan_fix / review / supervise の N=20 matrix と resume は pass。CLI JSON の `cost_usd` / `total_cost_usd` は実課金証跡とは断定しない。

MIG-004 以降の v0.1.0 Codex runner 方針は **Codex SDK primary ではなく `codex exec` primary**。Codex SDK `runStreamed` / `resumeThread` evidence は deferred / paid-risk-gated reference としてのみ扱い、AK-010 の adoption gate には使わない。MIG-004 live `codex exec` one-shot / explicit resume / isolated `resume --last` smoke に加え、#23 B の高回数 matrix、stored `thread_id` resume、sandbox write-denial / workspace-write evidence は operator 承認後、`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` unset を確認してから実行済み。明示 approval prompt の追加 live 実行は AK-010 実装時の fail-closed validation scope に残す。

AK-002 は S0 の仮設 visibility fixture を固定し、`.claude` / `.codex` provider-facing path が `.agents` SoT に解決されること、全 prompt_contract が `autokit-question` を参照することを local self-test で検証する。AK-002 では provider live model call を実行しない。

## AK-002 Runner Visibility Fixture Evidence

確認日: 2026-05-04 (Asia/Tokyo)

Fixture:

- `e2e/fixtures/runner-visibility/manifest.json`
- `e2e/fixtures/runner-visibility/issue.md`
- `e2e/fixtures/runner-visibility/.agents/skills/{autokit-implement,autokit-review,autokit-question}/SKILL.md`
- `e2e/fixtures/runner-visibility/.agents/agents/{planner,plan-verifier,implementer,reviewer,supervisor,doc-updater}.md`
- `e2e/fixtures/runner-visibility/.agents/prompts/{plan,plan-verify,plan-fix,implement,review,supervise,fix}.md`
- `e2e/fixtures/runner-visibility/.claude/{skills,agents}` symlink to `.agents`
- `e2e/fixtures/runner-visibility/.codex/{skills,agents}` symlink to `.agents`

Verification:

```text
Command: node --test --experimental-strip-types e2e/runners/runner-visibility.test.ts
Result: passed
tests: 1
```

```text
Command: node --experimental-strip-types e2e/runners/runner-visibility.ts --self-test --json
Result: passed
total: 29
passed: 29
failures: []
providers: ["claude","codex"]
promptContracts: ["plan","plan-verify","plan-fix","implement","review","supervise","fix"]
```

Coverage:

- `.claude/skills`, `.claude/agents`, `.codex/skills`, `.codex/agents` are symlinks resolving to real `.agents/skills` / `.agents/agents` directories inside the fixture root.
- `.claude/prompts` and `.codex/prompts` are absent, including broken symlink cases, matching SPEC §9.4.5: prompt templates are injected by autokit, not provider prompt directories.
- All 7 prompt_contract files end with exactly one `autokit-question` resolver reference line.
- `implement` / `fix` reference `autokit-implement`; `review` references `autokit-review`; those phase-specific references are exact resolver lines immediately before `autokit-question`.
- Fixed issue input declares the `status=need_input` / `autokit-question` scenario and required default answer. It does not execute provider runtime interception or resume.

Current decision: AK-002 local visibility fixture gate passed without provider live model calls. Provider runtime ingestion beyond filesystem visibility was later confirmed by #23 skill runtime visibility evidence.

## Evidence Sources

| Target | Source | Result |
|---|---|---|
| Claude Code CLI | https://code.claude.com/docs/en/cli-usage, local `claude --help` | `-p` / `--print`, `--output-format json`, `--json-schema`, `--resume`, `--session-id`, `--setting-sources`, `--allowedTools`, `--tools` を確認 |
| Claude Agent SDK TS | https://code.claude.com/docs/en/agent-sdk/typescript, https://code.claude.com/docs/en/agent-sdk/structured-outputs, npm package `@anthropic-ai/claude-agent-sdk@0.2.126` | `query`, `settingSources`, `resume`, `resumeSessionAt`, `outputFormat`, `allowedTools`, `disallowedTools`, `permissionMode`, `sandbox`, `persistSession` を確認 |
| Codex CLI | local `codex --help`, `codex exec --help`, `codex exec resume --help`, Homebrew cask metadata for `codex@0.128.0` | `codex exec --json`, `--output-schema`, `--output-last-message` / `-o`, `exec resume [SESSION_ID]`, `exec resume --last`, `--sandbox`, global `--ask-for-approval never`, `--ignore-user-config`, `--ignore-rules` を確認 |
| Codex SDK TS | https://github.com/openai/codex/blob/main/sdk/typescript/README.md, npm package `@openai/codex-sdk@0.128.0` | Deferred / paid-risk-gated reference only. `runStreamed` / `resumeThread` evidence は v0.1.0 Codex runner adoption gate に使わない |
| GitHub CLI merge | https://cli.github.com/manual/gh_pr_merge, local `gh pr merge --help` | `--match-head-commit <SHA>` and `--delete-branch` を確認 |

Context7 MCP は `Invalid or expired OAuth token` で使用不可だったため、上記 primary sources で代替した。

## Local Versions

| Tool / package | Version | Path / package | SHA / shasum |
|---|---:|---|---|
| Claude Code CLI | 2.1.126 | `/Users/ntaka/.local/bin/claude` | `87a1d05018ceadfc1fe616bfc10262b0503f51986f4af2dc42d1ed856ed3f7bb` |
| `@anthropic-ai/claude-agent-sdk` | 0.2.126 | npm | `6807bd40a78c34e00bc7d7eefbb7b38465e25c30` |
| Codex CLI in PATH | 0.128.0 | `/opt/homebrew/bin/codex` -> `/opt/homebrew/Caskroom/codex/0.128.0/codex-aarch64-apple-darwin` | binary sha256 `ff803d4b5c595af19b99c18db6def26539fdf4da23a035ab30809835631e8e4b`; Homebrew cask archive sha256 `f068202e8a898c240c8c068401bccd30ba7b56f61f5ffcd1483d545d47aaf3d5` |
| `@openai/codex` npm package | 0.128.0 | npm tarball `https://registry.npmjs.org/@openai/codex/-/codex-0.128.0.tgz` | shasum `c88babe2494b8f9308f8d4673cf1fcf17b12be79`; integrity `sha512-+xp6ODmFfBNnexIWRHApEaPXot2j6gyM8A5we/5IS/uY4eYHj4arETct4hQ5M4eO+MK7JY3ZU4xhuobhlysr0A==` |
| `@openai/codex-sdk` | 0.128.0 | npm | `105a80ba7c0623990da247f791abe3c215265b2a` |
| GitHub CLI | 2.92.0 | `/opt/homebrew/bin/gh` | `582a40676acf1394fcaf1c8c8bc5bad21806bd8c864b209d37b185c2df45dc92` |

Auth status evidence:

- `claude auth status`: logged in with `authMethod=claude.ai`, `apiProvider=firstParty`, subscription type `max`.
- `codex login status`: logged in using ChatGPT.
- `env | rg '^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY)='`: no matches on 2026-05-05 before local Codex CLI help/auth checks.
- `~/.codex/auth.json` / `$CODEX_HOME/auth.json` was not read. Auth file contents are password-equivalent and must not be copied to logs, artifacts, Issue bodies, PR comments, or backup bundles.
- `gh auth status`: logged in as `cattyneo`; token scopes include `repo` and `workflow`.

## Claude CLI Findings

Adoption target: primary Claude runner for `plan`, `plan_fix`, `review`, `supervise`.

Confirmed options:

- Non-interactive: `claude -p` / `--print`.
- Structured output: `--output-format json`, `--json-schema`.
- Resume: `--resume`, `--continue`, `--session-id`.
- Settings source: `--setting-sources user,project,local`; project-only is available via `--setting-sources project`.
- Tool control: `--allowedTools`, `--disallowedTools`, `--tools`.
- Subscription auth: local `claude auth status` confirms Claude.ai first-party auth works without setting `ANTHROPIC_API_KEY`.

Smoke evidence:

```text
Command: claude -p --output-format json --tools "" --setting-sources project --json-schema <schema> <prompt>
Result: passed
session_id: 5d9980d6-952d-4b17-9790-39457ea6d0c0
duration_ms: 8946
structured_output: {"status":"completed","summary":"ok","data":{"ok":true}}
cost_usd: 0.3747575
```

Unsupported / not yet proven:

- Full N=20 x 4 phase parse/schema/resume matrix is not run.
- `auto_mode` availability has not been validated.
- Runtime resolver visibility for `.claude/skills/` is AK-002 scope and not validated here.

Current decision: docs + one-shot smoke pass for AK-001 close gate. Full adoption gate remains follow-up #23.

## Claude Agent SDK TS Findings

Adoption target: experimental fallback only.

Confirmed package/type surface:

- Package: `@anthropic-ai/claude-agent-sdk@0.2.126`.
- Package metadata pins `claudeCodeVersion=2.1.126` and includes darwin arm64 optional dependency.
- Primary API: `query({ prompt, options })`.
- Settings: `settingSources?: ("user" | "project" | "local")[]`.
- Resume: `resume?: string`, `resumeSessionAt?: string`, `sessionId?: string`.
- Structured output: `outputFormat: { type: "json_schema", schema }`.
- Tool/safety controls: `allowedTools`, `disallowedTools`, `tools`, `permissionMode`, `sandbox`, `persistSession`.

Unsupported / not yet proven:

- Subscription-auth live SDK smoke was not run.
- N=50 structured output and resume matrix was not run.
- S0 criteria for experimental adoption are not met yet.

Current decision: do not implement `sdk-experimental.ts` until a later explicit SDK live matrix passes.

## Codex exec CLI Findings

Adoption target: primary Codex runner for `plan_verify`, `implement`, `fix`.

Help- and smoke-confirmed pinned CLI option surface (2026-05-05):

- PATH CLI: `codex-cli 0.128.0` at `/opt/homebrew/bin/codex`, installed from the Homebrew cask `codex` 0.128.0.
- Global approval policy: `codex -a never ...` / `codex --ask-for-approval never ...`. For non-interactive autokit runs, approval prompts are not auto-approved; failures are returned to the model / runner and handled fail-closed.
- Non-interactive runner: `codex exec [OPTIONS] [PROMPT]`.
- JSONL events: `codex exec --json`.
- Output schema validation: `codex exec --output-schema <FILE>`.
- Final output file: `codex exec -o <FILE>` / `--output-last-message <FILE>`.
- Resume subcommand for non-interactive sessions: `codex exec resume [SESSION_ID] [PROMPT]`.
- Resume latest non-interactive session: `codex exec resume --last`.
- Sandbox selection: `codex exec --sandbox read-only|workspace-write|danger-full-access`.
- Config isolation helpers: `--ignore-user-config` does not load `$CODEX_HOME/config.toml` but still uses auth; `--ignore-rules` skips user/project execpolicy `.rules`.
- ChatGPT-managed auth probe: `codex login status` printed `Logged in using ChatGPT`. This is the only observed positive auth string. API key auth / unknown auth modes were not observed and must be fail-closed by implementation rather than accepted via loose string matching.

Pinned latest CLI smoke from AK-001 (existing evidence, retained but not rerun in MIG-004):

```text
Command: npx -y @openai/codex@0.128.0 -a never exec --json --sandbox read-only --output-schema <schema> <prompt>
Result: passed
thread_id: 019df016-54e9-79d3-885f-6ed19cbadae3
agent_message: {"status":"completed","summary":"ok","data":{"ok":true}}
usage: input_tokens=50254, cached_input_tokens=2432, output_tokens=99, reasoning_output_tokens=72
```

Pinned latest CLI via spike entrypoint from AK-001 (existing evidence, retained but not rerun in MIG-004):

```text
Command: AUTOKIT_CODEX_NPX_PACKAGE=@openai/codex@0.128.0 node --experimental-strip-types e2e/runners/spike-runner-stability.ts --live-provider codex --allow-model-calls
Result: passed
thread_id: 019df022-8beb-7df0-a07e-b6f6a64d1e38
agent_message: {"status":"completed","summary":"ok","data":{"ok":true}}
usage: input_tokens=50254, cached_input_tokens=2432, output_tokens=113, reasoning_output_tokens=86
```

MIG-004 live PATH CLI smoke (operator-approved, 2026-05-05 Asia/Tokyo):

```text
Preflight:
codex --version: codex-cli 0.128.0
codex binary sha256: ff803d4b5c595af19b99c18db6def26539fdf4da23a035ab30809835631e8e4b
codex login status: Logged in using ChatGPT
env | rg '^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY)=': no matches
auth file read: not performed
```

```text
Command shape:
codex -a never exec --json --sandbox read-only --output-schema <schema> -o <output-file> <prompt>
Result: passed
exit_code: 0
thread_id: 019df420-1cfe-7c13-9c01-9e7f16271403
jsonl_lines: 4
event_types: thread.started, turn.started, item.completed, item:agent_message, turn.completed
output_file_valid_json: true
output_file: {"status":"completed","summary":"ok","data":{"ok":true,"mode":"codex_exec_live_smoke"}}
stderr: non-secret CLI/plugin warnings only; raw stderr is not persisted in repo docs
```

```text
Command shape:
codex -a never exec resume --json -o <output-file> 019df420-1cfe-7c13-9c01-9e7f16271403 <prompt>
Result: passed
exit_code: 0
thread_id: 019df420-1cfe-7c13-9c01-9e7f16271403
jsonl_lines: 4
event_types: thread.started, turn.started, item.completed, item:agent_message, turn.completed
output_file_valid_json: true
output_file: {"status":"completed","summary":"resumed","data":{"ok":true,"mode":"codex_exec_live_smoke"}}
```

```text
Command shape:
(cd <isolated-temp-cwd> && codex -a never exec --skip-git-repo-check --json --sandbox read-only --output-schema <schema> -o <output-file> <prompt>)
(cd <isolated-temp-cwd> && codex -a never exec resume --last --skip-git-repo-check --json -o <output-file> <prompt>)
Result: passed
exit_code: 0 / 0
thread_id: 019df423-c968-7ec3-a3d8-7041e985abd7
jsonl_lines: 4 / 4
event_types: thread.started, turn.started, item.completed, item:agent_message, turn.completed
output_file_valid_json: true / true
output_file: {"status":"completed","summary":"last","data":{"ok":true,"mode":"codex_exec_live_smoke"}}
```

`resume --last` caution:

- Running `codex exec resume --last` from the active repository cwd while this Codex desktop thread was newer selected thread `019df3e0-ae7a-7140-9bce-759130932326`, not the MIG-004 one-shot thread, and was interrupted after it failed to produce a final output file.
- AK-010 must not use `--last` as a generic resume strategy in shared or long-lived workspaces. It may be used only when cwd/session selection is isolated and verified, or for an explicit operator/debug path.
- Production resume should prefer the stored JSONL `thread_id` from the exact `codex exec` run.

Not exercised by MIG-004 live smoke:

- N=20 / high-count phase matrix.
- `read-only` write-denial and `workspace-write` create behavior for the CLI path.
- Explicit approval prompt generation under `-a never`.
- Codex SDK live matrix.

Event / session extraction decision:

- Existing smoke output exposed `thread_id` in JSONL and `agent_message` with the final structured JSON payload.
- AK-010 should store `codex_session_id` from the JSONL `thread_id` field only after the exact event sample is pinned for the runner version under test.
- The final user-facing structured output must come from final JSON / output schema validation (`--output-schema`) plus output-file validation (`--output-last-message` / `-o`), not from YAML parsing.
- Raw JSONL and final raw JSON are sanitized before parse/storage; raw unsanitized output is not persisted.

Confirmed / not confirmed matrix:

| Feature | Status | Evidence / handling |
|---|---|---|
| CLI version/path/checksum/install source | Confirmed | `which codex`, `codex --version`, `shasum -a 256`, `brew info codex --json=v2` |
| API key env unset before checks | Confirmed | `env | rg '^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY)='` returned no matches |
| ChatGPT-managed auth positive string | Confirmed | `codex login status`: `Logged in using ChatGPT` |
| `codex exec --json` | Confirmed by help + live smoke | Help lists `--json`; MIG-004 smoke emitted JSONL with `thread_id`, `item:agent_message`, and `usage` |
| `--output-schema` | Confirmed by help + live smoke | Help lists `--output-schema <FILE>`; MIG-004 one-shot used schema and produced valid final JSON |
| `--output-last-message` / `-o` | Confirmed by help + live smoke | MIG-004 one-shot / resume / isolated `--last` wrote valid final JSON files |
| `codex exec resume [SESSION_ID]` | Confirmed by help + live smoke | Explicit resume by stored `thread_id` passed and preserved the same `thread_id` |
| `codex exec resume --last` | Confirmed with isolation constraint | Passed in isolated temp cwd; unsafe as generic strategy in active repo cwd because it can select a newer desktop/workspace thread |
| sandbox flag | Partially confirmed | Help lists values; MIG-004 invoked `--sandbox read-only`; CLI write-denial/workspace-write behavior still requires AK-010 fixture/live validation |
| approval fail-closed | Partially confirmed | All MIG-004 live commands used `-a never`; explicit approval prompt generation was not forced and remains AK-010 validation scope |
| live `codex exec` one-shot during MIG-004 | Confirmed | Operator-approved run passed after API key env unset recheck |

Current decision: `codex exec` is the v0.1.0 primary Codex runner path. PATH Codex CLI 0.128.0 is now pinned for help / auth / one-shot / explicit resume / output-file evidence. AK-010 may build against explicit stored `thread_id` resume and `-o` output-file parsing, but must still fail closed for unconfirmed CLI sandbox write behavior, explicit approval prompt behavior, unknown auth strings, and any mismatch in JSONL event shape. Any unconfirmed required CLI feature stops AK-010 implementation.

## Deferred Codex SDK Reference

Adoption target: none for v0.1.0. This section is retained only as paid-risk-gated reference evidence.

Do not use this section as AK-009 / AK-010 adoption evidence. The active v0.1.0 runner gates are #23 A (`claude -p`) and #23 B (`codex exec`) only.

Confirmed package/type surface from AK-001:

- Package: `@openai/codex-sdk@0.128.0`.
- `Codex.startThread(options?)` and `Codex.resumeThread(id, options?)`.
- `Thread.run(input, { outputSchema? })` and `Thread.runStreamed(input, { outputSchema? })`.
- `ThreadOptions.sandboxMode`: `read-only` / `workspace-write` / `danger-full-access`.
- `ThreadOptions.approvalPolicy`: `never` / `on-request` / `on-failure` / `untrusted`.
- `ThreadOptions.networkAccessEnabled`, `workingDirectory`, `skipGitRepoCheck`, `additionalDirectories`.

Codex SDK one-shot smoke from AK-001 (deferred reference only):

```text
Command: temp Node project with @openai/codex-sdk@0.128.0 and @openai/codex@0.128.0, workingDirectory=<this worktree>, sandboxMode=read-only, approvalPolicy=never
runStreamed result: passed
thread_id: 019df025-ce1a-7fd1-9cb2-832b5399d662
runStreamed final: {"status":"completed","summary":"ok","data":{"ok":true}}
resumeThread result: passed
resumeThread final: {"status":"completed","summary":"resumed","data":{"ok":true}}
usage: input_tokens=50252, cached_input_tokens=2432, output_tokens=95, reasoning_output_tokens=68
```

Codex SDK sandbox one-shot smoke from AK-001 (deferred reference only):

```text
Command: temp Node project with @openai/codex-sdk@0.128.0 and @openai/codex@0.128.0, workingDirectory=<temp git repo>, approvalPolicy=never, networkAccessEnabled=false
read-only write attempt: passed
read-only thread_id: 019df027-95eb-7a30-bd4c-4ac1ae052dc0
read-only observed: touch failed: readonly-should-not-exist.txt: Operation not permitted
read-only file exists after run: false
workspace-write create: passed
workspace-write thread_id: 019df027-e93a-7082-8c7f-fb4d4658e3e5
workspace-write file exists after run: true
workspace-write file content: sdk workspace write ok
```

Current decision: SDK `runStreamed` / `resumeThread` evidence is not a v0.1.0 Codex runner adoption gate. Do not implement a Codex SDK runner or execute a Codex SDK full matrix without separate paid-risk-gated approval.

## GitHub CLI Merge Findings

Confirmed with official manual and local `gh pr merge --help`:

- `--match-head-commit <SHA>` merges only if the PR head matches the supplied SHA.
- `--delete-branch` deletes the local and remote branch after merge.
- Merge queue behavior is handled by `gh pr merge` without requiring a strategy when the target branch requires a merge queue.

Current decision: use `--match-head-commit` for head-race protection and `--delete-branch` only after merge success.

## prompt_contract Fixture Results

Command:

```sh
node --experimental-strip-types e2e/runners/spike-runner-stability.ts --self-test --json
```

Result:

```json
{
  "total": 19,
  "passedExpectations": 19,
  "failClosedCount": 8,
  "failures": []
}
```

Pinned fixtures:

- `completed-plan.json`: pass.
- `completed-plan-verify.json`: pass.
- `completed-plan-fix.json`: pass.
- `completed-implement.json`: pass.
- `completed-review.json`: pass.
- `completed-supervise-all-reject.json`: pass.
- `completed-supervise-with-fix.json`: pass.
- `completed-fix.json`: pass.
- `need-input-with-default.json`: pass.
- `need-input-missing-default.json`: fail closed with `prompt_contract_violation`.
- `paused-recoverable.json`: pass.
- `failed-recoverable.json`: pass.
- `schema-mismatch.json`: fail closed with `prompt_contract_violation`.
- `supervise-missing-fix-prompt.json`: fail closed with `prompt_contract_violation`.
- `supervise-duplicate-id.json`: fail closed with `prompt_contract_violation`.
- `supervise-repeated-accept-id.json`: fail closed with `prompt_contract_violation`.
- `fix-duplicate-id.json`: fail closed with `prompt_contract_violation`.
- `fix-repeated-resolved-id.json`: fail closed with `prompt_contract_violation`.
- `failed-extra-field.json`: fail closed with `prompt_contract_violation`.

## AK-001 Close Gate / Follow-up Gate

AK-001 close gate is limited to low-cost evidence:

- Official docs / CLI help / package metadata / package type definitions evidence.
- One-shot live smoke for Claude CLI and Codex CLI paths. Codex SDK smoke is deferred reference only.
- `prompt_contract` pass / fail-closed fixture self-test.
- Full matrix execution plan with preconditions and stop criteria.

Full N=20 adoption evidence for primary runners is rewritten follow-up #23. #23 is split into Claude CLI and `codex exec` gates. Codex uses `codex exec` primary; SDK full matrix is deferred to #44 and is not a v0.1.0 blocker.

Issue #23 live adoption execution (2026-05-05 Asia/Tokyo, operator-approved):

- API key guard: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` were unset before live execution.
- Harness: `e2e/runners/runner-adoption-matrix.ts --allow-model-calls`, using `buildRunnerEnv(process.env)` and §9.3 prompt_contract validation.
- Claude CLI: `claude --version` = `2.1.126 (Claude Code)`, first-party `claude.ai` subscription auth. A runner-env preflight initially failed because the runner allowlist omitted `USER` / `LOGNAME`; `packages/core/src/env-allowlist.ts` now preserves those non-secret macOS identity keys while still excluding API keys, GitHub tokens, `AUTOKIT_*`, and arbitrary user env.
- #23 A result: `plan` / `plan_fix` / `review` / `supervise` each passed 20/20 structured-output attempts and 1/1 resume attempt. Prompt_contract validation success rate: 100% for each phase. Detailed artifact: `docs/artifacts/issue-23-claude-adoption-matrix-2026-05-05.json`.
- Claude CLI cost telemetry total recorded by the harness: `6.7962919999999905` USD. This is CLI telemetry only and is not proof of actual subscription billing.
- Codex CLI: `codex --version` = `codex-cli 0.128.0`, ChatGPT-managed auth. B matrix used `codex -a never exec --json --sandbox <mode> --output-schema <schema-file> -o <output-file>` and stored JSONL `thread_id` for resume.
- #23 B result: `plan_verify` / `implement` / `fix` each passed 20/20 final JSON + schema validation attempts. Resume passed 5/5 total (`plan_verify` 3/3 including the two spare attempts, `implement` 1/1, `fix` 1/1). Detailed artifact: `docs/artifacts/issue-23-codex-adoption-matrix-2026-05-05.json`.
- Codex sandbox evidence: isolated `read-only` write-denial passed with no file created; isolated `workspace-write` success passed with `sandbox-check.txt` created and verified. Detailed artifact: `docs/artifacts/issue-23-codex-sandbox-check-2026-05-05.json`.
- Skill runtime visibility evidence: Claude `/autokit-question` project skill resolution and Codex `.codex/skills` / `.agents/skills` prompt-visible skill lookup both returned the expected `autokit-question` rule from the S0 fixture. Detailed artifact: `docs/artifacts/issue-23-skill-runtime-visibility-2026-05-05.json`.
- Harness correction note: two pre-run Codex `plan_verify` attempts failed before the recorded B matrix because the new harness emitted an invalid strict JSON schema for an empty `findings` array. Those attempts were stopped, the schema was fixed, and they are not counted as provider adoption failures.
- Current adoption decision: #23 A and #23 B primary runner adoption gates pass. AK-009 may treat Claude CLI `claude -p` as adopted after this PR merges. AK-010 may treat `codex exec` as adopted after this PR merges, while still implementing fail-closed handling for version drift, unknown auth mode strings, JSONL shape mismatch, approval prompts, and sandbox violations.

## Full Matrix Execution Plan

This section records the execution shape, preconditions, and stop criteria used for #23.

### Claude primary runner

Required by SPEC §9.1.1 A:

- `plan`, `plan_fix`, `review`, `supervise`: 20 structured-output attempts each = 80 live model calls.
- Resume: one resume attempt per phase = 4 additional live calls.
- Expected total: 84 Claude CLI calls.

Cost / billing risk:

- The one-shot Claude smoke JSON reported `cost_usd=0.3747575`.
- This is telemetry from the CLI output, not proof of actual account billing under a Claude subscription.
- If the full matrix were billed like that one-shot, a rough linear estimate would be about `31.48 USD` (`0.3747575 * 84`).
- Actual billing / cost may differ because subscription entitlements, prompt cache, selected model, output length, retries, and CLI defaults can change.

Suggested stop criteria:

- Stop on unsupported CLI option / auth mismatch / schema output failure that cannot be attributed to transient provider behavior.
- Stop on unexpected paid spend, unresolved billing uncertainty, repeated provider 429, or a cost ceiling chosen by the operator.
- Record phase, attempt number, session id, structured output, parse/schema result, and resume result in this file or a linked artifact.

### Codex primary runner

Required by SPEC §9.1.1 B:

- `plan_verify`, `implement`, `fix`: 20 structured-output attempts each = 60 live `codex exec` calls.
- Resume: 3 phase resume attempts + 2 spare attempts = 5 additional live `codex exec resume` calls.
- Sandbox: at least one read-only write-denial and one workspace-write success check per relevant phase before considering the sandbox evidence complete.
- Expected minimum: 65 Codex CLI calls plus sandbox checks.

Preconditions:

- PATH Codex CLI `0.128.0` is the current pinned local CLI. Reconfirm `codex --version`, checksum, and `codex login status` immediately before execution.
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` must be unset immediately before execution.
- High-count live matrix requires subscription / billing扱い確認または operator 明示承認.
- Use `codex -a never exec --json --sandbox <mode> --output-schema <schema-file> ...` unless a later pinned evidence update changes the invocation.
- Use stored `codex exec resume [SESSION_ID]` as the primary resume path. `codex exec resume --last` is allowed only in isolated cwd/debug contexts where cwd/session selection has been verified.

Suggested stop criteria:

- Stop on CLI version drift, unsupported model under ChatGPT auth, API key env present, auth mode unknown, missing `thread_id`, failed `codex exec resume`, unrecognized JSONL event shape, schema mismatch, approval prompt, or sandbox write escaping the expected boundary.
- Record `thread_id`, final structured output, schema validation result, sandbox mode, output file path if used, and file-system evidence for each relevant attempt.
