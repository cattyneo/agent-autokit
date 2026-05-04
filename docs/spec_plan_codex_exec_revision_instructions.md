# SPEC / PLAN 修正指示: Codex SDK primary から `codex exec` primary へ

## 方針

- v0.1.0 の Codex runner は `codex exec` CLI primary に切り替える。
- `@openai/codex-sdk` / Codex SDK runner は v0.1.0 では採用しない。
- Codex SDK は `deferred` / `experimental` / `paid-risk-gated` として扱う。
- OpenAI Platform API 課金を避けるため、Codex は ChatGPT-managed CLI auth のみ許可する。
- `OPENAI_API_KEY` / `CODEX_API_KEY` が存在する実行経路は fail-closed にする。
- GitHub / git 操作は引き続き core 単独所有。Codex は worktree 内編集と検証のみ担当する。

## 意図

- 「Codex を使うが API 費用は発生させない」という運用方針に SPEC / PLAN / Issue train を整合させる。
- `Codex SDK primary` と `subscription auth only` の矛盾を解消する。
- Issue #23 の full matrix evidence が paid/API execution を含む曖昧さを取り除く。
- AK-009 / AK-010 以降を、Codex SDK 採用済み前提ではなく `codex exec` runner 採用前提で再開できる状態にする。

## 参照前提

- OpenAI Codex auth docs: ChatGPT login は subscription access、API key は usage-based access。
- `codex exec` は non-interactive 実行経路として採用候補にする。
- JSONL、structured output、resume、final output file、session id field などの exact CLI contract は MIG-004 の pinned Codex CLI evidence で確認するまで provisional とする。
- CI / public automation で ChatGPT-managed auth を使う場合は advanced 扱い。v0.1.0 では local / trusted private runner 前提に限定する。

## SPEC 修正ポイント

### 1. 概要 / 用語 / システム構成

- `Codex SDK` / `Codex SDK runner` 表記を `Codex CLI exec runner` に変更する。
- `runner` 用語定義を更新する。
  - 旧: `claude -p runner / Codex SDK runner`
  - 新: `claude -p runner / codex exec runner`
- `implementer` / `plan-verifier` の責務は維持する。
- `agent` に git / gh / push / merge を許可しない方針は維持する。

### 2. ランタイム前提 / 認証

- `codex CLI (codex login 済み、サブスク枠)` を明確に primary runtime とする。
- `OPENAI_API_KEY` に加えて `CODEX_API_KEY` を禁止対象に追加する。
- doctor / login-shell env probe / cwd `.env*` 検査 / runner env allowlist / sanitize pattern / AC の全てに `CODEX_API_KEY` を追加する。
- `codex login status` 等で auth mode を確認できる場合、ChatGPT-managed auth 以外を fail にする。
- `~/.codex/auth.json` は password 相当として扱う。ログ / backup / artifact / Issue コメントに出さない。

### 3. ディレクトリ構造

- `packages/codex-runner` の説明を `Codex SDK wrapper` から `codex exec CLI wrapper` に変更する。
- SDK 用の `runStreamed` / `resumeThread` ファイル名や説明を避ける。
- 推奨構成:

```txt
packages/codex-runner/
  src/
    auth.ts      # ChatGPT-managed auth probe / API key auth rejection
    runner.ts    # codex exec spawn / JSONL parser / final JSON reader
    resume.ts    # codex exec resume <session_id>
    sandbox.ts   # CLI flags + core independent sandbox check
```

### 4. tasks.yaml / provider_sessions

- `codex_thread_id` は SDK 前提に見えるため、`codex_session_id` への変更を検討する。
- `resumeThread` 前提の説明を `codex exec resume <session_id>` 前提に変更する。
- 既存互換を残す場合も、v0.1.0 の SoT 名は `codex_session_id` を優先する。

### 5. Runner 採用方針

- SPEC §9.1 を以下の方針に更新する。

```md
- Claude: `claude -p` runner を primary
- Codex: `codex exec` CLI runner を primary
- Codex SDK は v0.1.0 では採用しない。v0.2 以降の experimental / paid-risk-gated runner とする
- API key fallback は MVP で持たない
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` は unset 必須
- Codex runner は ChatGPT-managed CLI auth のみ許可する
```

### 6. Runner 採用基準

- `primary runner: Codex SDK` を `primary runner: Codex CLI exec` に置換する。
- 採用基準は `runStreamed` / `resumeThread` ではなく、MIG-004 の pinned evidence で確認済みの CLI contract に基づいて以下へ変更する。
  未確認の項目は SPEC / PLAN の必須要件として断定せず、AK-010 実装前の停止条件として記録する。
  - `codex exec --json` の event parse
  - `thread.started.thread_id` または session id の保存
  - `--output-schema` による final output validation
  - `--output-last-message` / `-o` による final JSON 取得
  - `codex exec resume <session_id>` の resume
  - sandbox flag / approval policy の実行証跡
  - ChatGPT-managed auth で `OPENAI_API_KEY` / `CODEX_API_KEY` unset のまま動作
- SDK full matrix は v0.1.0 の採用 gate から外す。

### 7. Runner 契約

- `AgentRunInput.resume.codexThreadId` / `AgentRunOutput.session.codexThreadId` は `codexSessionId` へ変更を検討する。
- SDK と CLI の差異を吸収する runner 契約は維持する。
- Codex runner の parse pipeline は、MIG-004 で各 flag / event / output form が確認できた範囲で次へ寄せる。
  未確認なら代替方針または停止条件を SPEC / PLAN / AK-010 に明記する。

```txt
codex exec JSONL stream
→ raw bytes sanitize
→ JSONL event parse
→ session id 保存
→ final message file read
→ JSON parse
→ schema validation
→ AgentRunOutput.structured へ転写
```

### 8. prompt_contract / schema

- 内部の `prompt_contract` SSOT は維持する。
- Claude は YAML/JSON text parse を許容する。
- Codex は `--output-schema` による final JSON を優先する。
- `plan-verify` / `implement` / `fix` は Codex CLI exec から schema-valid final JSON を返す前提に変更する。

### 9. 質問ループ

- Codex は non-interactive runner として扱う。
- 実行中 callback 前提を避ける。
- `need_input` は final output として受け取る方針に寄せる。
- TUI 回答後の resume invocation は MIG-004 の pinned evidence に従う。
  `codex exec resume <session_id> <answer>` 形式が未確認なら、AK-010 実装前に停止して契約を確定する。
- `-y` は従来通り `question.default` を回答として使う。

### 10. sandbox / approval

- `plan_verify`: read-only 相当。
- `implement` / `fix`: workspace-write 相当。
- approval は自動承認しない。必要な approval が発生した場合は fail-closed / paused にする。
- provider sandbox に依存しきらず、core independent sandbox check は維持する。

### 11. failure.code / audit

- 必要なら `approval_unavailable` 等の failure code 追加を検討する。
- 追加する場合は SPEC の failure.code、audit kind、AC、PLAN traceability を同時更新する。
- 既存の `network_required` で足りる場合は新 code を増やさない。

### 12. 関連リンク / 将来拡張

- Codex SDK primary 昇格は v0.2+ に移送する。
- `@openai/codex-sdk` の evaluation Issue は paid-risk-gated として分離する。

## PLAN 修正ポイント

### 1. ゴール / MVP スコープ

- `runner: claude -p primary + Codex SDK` を `runner: claude -p primary + codex exec primary` に変更する。
- Codex SDK は v0.1.0 の非スコープに移す。
- API key 不可に `CODEX_API_KEY` を追加する。

### 2. S0 / AK-001 / #23

- AK-001 は docs evidence / one-shot smoke / prompt_contract fixture / full matrix 計画までの low-cost gate として維持する。
- #23 は現行の `Codex SDK N=20` を含む形では使わない。
- #23 を rewrite するか、replacement Issue を作る。
- 新 gate は `codex exec` subscription-auth matrix とする。
- SDK matrix は separate paid-risk-gated Issue に移す。

### 3. Issue breakdown

- AK-010 を `codex-runner` から `codex-cli-exec-runner` 相当に変更する。
- AK-010 の scope を以下へ変更する。
  - `codex exec` auth / runner / resume / sandbox
  - JSONL parser
  - output-schema validation
  - final message file reader
  - process group / hard timeout
  - need_input final-output turn loop
- AK-010 の blocked-by を新 `codex exec` evidence gate に変更する。
- AK-010 の非ゴールに Codex SDK runner を追加する。

### 4. S2 Runner 実装

- Codex runner tasks を SDK から CLI exec に変更する。
- 削除 / 置換対象:
  - `runStreamed`
  - `resumeThread`
  - Codex SDK TypeScript API 前提
- 追加対象:
  - `codex exec --json`
  - `--output-schema`
  - `--output-last-message` / `-o`
  - `codex exec resume <session_id>`
  - `codex login status` または同等 auth probe
  - `CODEX_API_KEY` rejection

### 5. S3 Workflows

- plan / implement / fix の provider assignment は維持する。
- Codex phase の実行方式のみ `codex exec` に変更する。
- Codex `need_input` は final output → TUI → resume turn として扱う。
- checkpoint / git / gh 所有は変更しない。

### 6. テスト戦略

- `codex-runner` test matrix を SDK mock から CLI exec subprocess mock に変更する。
- JSONL event fixture を追加する。
- final JSON schema fixture を追加する。
- resume session fixture を追加する。
- API key env rejection に `CODEX_API_KEY` を追加する。
- `codex exec` auth mode が API key の場合 fail する fixture を追加する。

### 7. リスク表

- `Codex SDK sandbox / approval policy` リスクを削除または deferred に変更する。
- 追加リスク:
  - `codex exec` は SDK より制御粒度が低い
  - ChatGPT-managed auth は CI では advanced / trusted runner 前提
  - subscription usage limit は消費する
  - auth.json の取り扱いが機密になる
  - non-interactive 実行では途中 approval / 質問 callback が制限される

## 変更しない前提

- core が git / gh / PR / merge を単独所有する。
- parallel は v0.1.0 では 1 固定。
- Claude は `claude -p` primary のまま。
- Claude Agent SDK は experimental / deferred のまま。
- prompt_contract 1:1、sanitize、audit、state machine、retry / resume 方針は維持する。
- v0.1.0 は private 配布のまま。

## 修正後に確認すること

- SPEC / PLAN に `Codex SDK primary` が残っていない。
- `runStreamed` / `resumeThread` が v0.1.0 必須要件として残っていない。
- `OPENAI_API_KEY` だけでなく `CODEX_API_KEY` も禁止対象に入っている。
- Issue #23 が SDK full matrix gate のまま残っていない。
- AK-010 の scope / blocked-by / AC / tests が `codex exec` 前提になっている。
- Codex SDK は deferred / paid-risk-gated として一貫している。
