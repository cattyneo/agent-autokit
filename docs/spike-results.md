# AK-001 Runner / SDK Contract Spike Results

確認日: 2026-05-04 (Asia/Tokyo)

## Summary

AK-001 は S0 の不確実性を S1 前に潰すための spike。ここでは公式 docs / CLI help / npm package metadata / package type definitions / one-shot live smoke の結果を固定する。

Full N=20 adoption matrix は未実行。Claude Code の 1 回 smoke が約 0.37 USD だったため、plan / plan_fix / review / supervise の N=20 matrix は明示的な実行承認または budget 指定なしに走らせない。

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

Current decision: docs + local smoke pass, but full adoption gate remains pending explicit live matrix approval.

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

Unsupported / not yet proven:

- PATH Codex CLI is too old for the default model path and must be upgraded or bypassed with pinned `@openai/codex@0.128.0`.
- Full N=20 x 3 phase parse/schema/resume matrix is not run.
- `runStreamed` / `resumeThread` live SDK smoke is not run; only CLI structured smoke is proven.

Current decision: primary Codex runner can proceed only if autokit pins or verifies Codex CLI `>=0.128.0` for this environment. PATH CLI 0.122.0 is not acceptable for AK-001 full adoption.

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
  "total": 5,
  "passedExpectations": 5,
  "failClosedCount": 2,
  "failures": []
}
```

Pinned fixtures:

- `completed-plan.json`: pass.
- `need-input-with-default.json`: pass.
- `need-input-missing-default.json`: fail closed with `prompt_contract_violation`.
- `paused-recoverable.json`: pass.
- `schema-mismatch.json`: fail closed with `prompt_contract_violation`.

## Remaining Gate

AK-001 cannot be considered fully green until the user explicitly chooses one of the following:

1. Approve full live matrix execution and expected model spend.
2. Reduce AK-001 acceptance to docs + one-shot smoke + fixture self-test, and create a follow-up Issue for full N=20 adoption evidence.
3. Upgrade or pin Codex CLI to `@openai/codex@0.128.0` first, then run the Codex SDK/CLI matrix.
