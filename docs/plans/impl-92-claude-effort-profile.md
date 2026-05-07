# Issue #92 Claude runner effort profile mapping

## Goal
Claude runner が `ResolvedEffort` を autokit effort profile (`model` / `max_turns` / `timeout_ms` / prompt policy) に変換し、全 7 phase で同じ runner 境界を fail-closed に保つ。

## Observable Success
- `effort=auto|low|medium|high` が Claude profile として `model=(auto default|sonnet|sonnet|opus)`, `max_turns=16|8|16|32`, `timeout_ms=1800000|1200000|1800000|3600000` に解決される。
- `model:auto` かつ `effort=low|medium|high` では `--model sonnet|sonnet|opus` が Claude CLI args に乗る。明示 model は既存互換として優先する。
- prompt には effort profile block が入り、low/default/high で prompt policy が分岐する。
- stale / missing `effort` と stale `effective_permission` は runner 境界で fail-closed する。
- live provider subprocess / API-key-backed run は実行しない。

## Constraints
- Scope は #92 のみ。Phase 4 の prompt 自由記述改善、Codex runner、audit/state-machine owner は触らない。
- Claude CLI は local help / Context7 で `--model`, `--json-schema`, `--tools`, `--disallowedTools` を確認済み。`--max-turns` は現行 help にないため使用しない。
- timeout 明示優先は #89/#91 の workflow resolved effort timeout を runner が受け取る契約として維持する。

## Tasks
- [x] Claude runner tests を先に更新: 4 effort x 7 phase profile matrix、model arg mapping、explicit model priority、prompt policy branch、metadata drift rejection。
- [x] `packages/claude-runner/src/index.ts` に profile builder を追加し、`buildClaudeArgs()` / `formatClaudePrompt()` で消費する。
- [x] `assertClaudeInput()` に `effort.phase/provider` と `effective_permission` 整合チェックを追加する。
- [x] targeted tests → required gates (`lint`, `typecheck`, `test`, `build`) を実行する。

## Done When
- [ ] Issue #92 AC と non-goals が PR body に明記される。
- [x] `npx --yes bun@1.3.13 test packages/claude-runner/src/index.test.ts packages/workflows/src/index.test.ts` が通る。
- [x] required gates が通り、provider-backed tests は not run として明示される。
