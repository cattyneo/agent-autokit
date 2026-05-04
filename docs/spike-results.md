# S0 Runner / SDK Spike Results

確認日: 2026-05-04 (Asia/Tokyo)

## Summary

AK-001 は S0 の不確実性を S1 前に潰すための spike。ここでは公式 docs / CLI help / npm package metadata / package type definitions / one-shot live smoke / prompt_contract fixture / full matrix 実行計画の結果を固定する。

Full N=20 adoption matrix は未実行で、follow-up #23 に分離する。`claude -p` は subscription auth (`claude.ai`, subscription type `max`) で実行できるが、CLI JSON の `cost_usd` / `total_cost_usd` は実課金証跡とは断定しない。plan / plan_fix / review / supervise の N=20 matrix は、operator が subscription / billing 扱いを確認するか、明示的な実行承認を出すまで走らせない。

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

- `.claude/skills`, `.claude/agents`, `.codex/skills`, `.codex/agents` are symlinks resolving to `.agents/skills` / `.agents/agents`.
- `.claude/prompts` and `.codex/prompts` are absent, matching SPEC §9.4.5: prompt templates are injected by autokit, not provider prompt directories.
- All 7 prompt_contract files contain exactly one `autokit-question` reference.
- `implement` / `fix` reference `autokit-implement`; `review` references `autokit-review`; planner / verifier / supervisor prompts do not reference implementation or review skills.
- Fixed issue input exercises the `status=need_input` / `autokit-question` resolver path.

Current decision: AK-002 local visibility fixture gate passed without provider live model calls. Provider runtime ingestion beyond filesystem visibility remains part of later runner adoption / implementation evidence (#23, AK-009, AK-010).

## Evidence Sources

| Target | Source | Result |
|---|---|---|
| Claude Code CLI | https://code.claude.com/docs/en/cli-usage, local `claude --help` | `-p` / `--print`, `--output-format json`, `--json-schema`, `--resume`, `--session-id`, `--setting-sources`, `--allowedTools`, `--tools` を確認 |
| Claude Agent SDK TS | https://code.claude.com/docs/en/agent-sdk/typescript, https://code.claude.com/docs/en/agent-sdk/structured-outputs, npm package `@anthropic-ai/claude-agent-sdk@0.2.126` | `query`, `settingSources`, `resume`, `resumeSessionAt`, `outputFormat`, `allowedTools`, `disallowedTools`, `permissionMode`, `sandbox`, `persistSession` を確認 |
| Codex SDK TS | https://github.com/openai/codex/blob/main/sdk/typescript/README.md, npm package `@openai/codex-sdk@0.128.0` | `Codex`, `startThread`, `resumeThread`, `run`, `runStreamed`, `ThreadOptions.sandboxMode`, `approvalPolicy`, `networkAccessEnabled`, `workingDirectory`, `skipGitRepoCheck` を確認 |
| GitHub CLI merge | https://cli.github.com/manual/gh_pr_merge, local `gh pr merge --help` | `--match-head-commit <SHA>` and `--delete-branch` を確認 |

Context7 MCP は `Invalid or expired OAuth token` で使用不可だったため、上記 primary sources で代替した。

## Local Versions

| Tool / package | Version | Path / package | SHA / shasum |
|---|---:|---|---|
| Claude Code CLI | 2.1.126 | `/Users/ntaka/.local/bin/claude` | `87a1d05018ceadfc1fe616bfc10262b0503f51986f4af2dc42d1ed856ed3f7bb` |
| `@anthropic-ai/claude-agent-sdk` | 0.2.126 | npm | `6807bd40a78c34e00bc7d7eefbb7b38465e25c30` |
| Codex CLI in PATH | 0.122.0 | `/opt/homebrew/bin/codex` | `eeb6bd7df3b82350da3e1d5f757dda5b2af221b5047942b071e6fd9f5c112a58` |
| `@openai/codex` via npx | 0.128.0 | npm | latest checked with `npx -y @openai/codex@0.128.0 --version` |
| `@openai/codex-sdk` | 0.128.0 | npm | `105a80ba7c0623990da247f791abe3c215265b2a` |
| GitHub CLI | 2.92.0 | `/opt/homebrew/bin/gh` | `582a40676acf1394fcaf1c8c8bc5bad21806bd8c864b209d37b185c2df45dc92` |

Auth status evidence:

- `claude auth status`: logged in with `authMethod=claude.ai`, `apiProvider=firstParty`, subscription type `max`.
- `codex login status`: logged in using ChatGPT.
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

## Codex SDK / CLI Findings

Adoption target: primary Codex runner for `plan_verify`, `implement`, `fix`.

Confirmed package/type surface:

- Package: `@openai/codex-sdk@0.128.0`.
- `Codex.startThread(options?)` and `Codex.resumeThread(id, options?)`.
- `Thread.run(input, { outputSchema? })` and `Thread.runStreamed(input, { outputSchema? })`.
- `ThreadOptions.sandboxMode`: `read-only` / `workspace-write` / `danger-full-access`.
- `ThreadOptions.approvalPolicy`: `never` / `on-request` / `on-failure` / `untrusted`.
- `ThreadOptions.networkAccessEnabled`, `workingDirectory`, `skipGitRepoCheck`, `additionalDirectories`.
- SDK wraps the Codex CLI from `@openai/codex` and persists threads under `~/.codex/sessions`.

Local CLI smoke:

```text
Command: codex -a never exec --json --sandbox read-only --output-schema <schema> <prompt>
Result: failed
error: The 'gpt-5.5' model requires a newer version of Codex.
PATH CLI: codex-cli 0.122.0
```

Model override smoke:

```text
Command: codex -a never exec -m gpt-5.2-codex --json --sandbox read-only --output-schema <schema> <prompt>
Result: failed
error: The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.
```

Pinned latest CLI smoke:

```text
Command: npx -y @openai/codex@0.128.0 -a never exec --json --sandbox read-only --output-schema <schema> <prompt>
Result: passed
thread_id: 019df016-54e9-79d3-885f-6ed19cbadae3
agent_message: {"status":"completed","summary":"ok","data":{"ok":true}}
usage: input_tokens=50254, cached_input_tokens=2432, output_tokens=99, reasoning_output_tokens=72
```

Pinned latest CLI via spike entrypoint:

```text
Command: AUTOKIT_CODEX_NPX_PACKAGE=@openai/codex@0.128.0 node --experimental-strip-types e2e/runners/spike-runner-stability.ts --live-provider codex --allow-model-calls
Result: passed
thread_id: 019df022-8beb-7df0-a07e-b6f6a64d1e38
agent_message: {"status":"completed","summary":"ok","data":{"ok":true}}
usage: input_tokens=50254, cached_input_tokens=2432, output_tokens=113, reasoning_output_tokens=86
```

Codex SDK one-shot smoke:

```text
Command: temp Node project with @openai/codex-sdk@0.128.0 and @openai/codex@0.128.0, workingDirectory=<this worktree>, sandboxMode=read-only, approvalPolicy=never
runStreamed result: passed
thread_id: 019df025-ce1a-7fd1-9cb2-832b5399d662
runStreamed final: {"status":"completed","summary":"ok","data":{"ok":true}}
resumeThread result: passed
resumeThread final: {"status":"completed","summary":"resumed","data":{"ok":true}}
usage: input_tokens=50252, cached_input_tokens=2432, output_tokens=95, reasoning_output_tokens=68
```

Codex SDK sandbox one-shot smoke:

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

Unsupported / not yet proven:

- PATH Codex CLI is too old for the default model path and must be upgraded or bypassed with pinned `@openai/codex@0.128.0`.
- Full N=20 x 3 phase parse/schema/resume matrix is not run.
- `runStreamed` / `resumeThread` one-shot SDK smoke passed.
- SDK sandbox one-shot passed for read-only write denial and workspace-write creation in a temp git repo. Full phase-specific sandbox matrix is not run.

Current decision: PATH CLI 0.122.0 is not acceptable for AK-001 full adoption. Pinning or upgrading Codex CLI to `>=0.128.0` is a necessary precondition, but it is not sufficient by itself: the full N=20 SDK matrix still requires live evidence before the Codex runner can satisfy SPEC §9.1.1 B.

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
- One-shot live smoke for Claude CLI and Codex CLI / SDK paths.
- `prompt_contract` pass / fail-closed fixture self-test.
- Full matrix execution plan with preconditions and stop criteria.

Full N=20 adoption evidence is follow-up #23 and remains required before AK-009 / AK-010 can treat the primary runners as adopted. Codex still requires `@openai/codex@0.128.0` / `@openai/codex-sdk@0.128.0` or a newer PATH CLI before its full matrix.

## Full Matrix Execution Plan (Not Run)

This section is a decision aid only. It is not evidence that the matrix passed.

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

- `plan_verify`, `implement`, `fix`: 20 structured-output attempts each = 60 live SDK calls.
- Resume: 3 phase resume attempts + 2 spare attempts = 5 additional live calls.
- Sandbox: at least one read-only write-denial and one workspace-write success check per relevant phase before considering the sandbox evidence complete.
- Expected minimum: 65 Codex SDK calls plus sandbox checks.

Preconditions:

- PATH Codex CLI `0.122.0` is not acceptable for this environment.
- Use `@openai/codex@0.128.0` / `@openai/codex-sdk@0.128.0` or upgrade PATH CLI before the matrix.
- Keep `approvalPolicy=never` and `networkAccessEnabled=false` unless the matrix case explicitly requires a different setting.

Suggested stop criteria:

- Stop on CLI / SDK version drift, unsupported model under ChatGPT auth, missing thread id, failed `resumeThread`, or sandbox write escaping the expected boundary.
- Record thread id, final structured output, schema validation result, sandbox mode, and file-system evidence for each relevant attempt.
