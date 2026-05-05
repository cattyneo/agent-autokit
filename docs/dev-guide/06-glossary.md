# 06. 用語集

> 最低限。詳細定義は SPEC §1.4。

| 用語 | 意味 |
|------|------|
| **runtime** | `autokit run` の処理本体 |
| **runner** | 子プロセス起動の薄いラッパ。Claude / Codex の 2 種 |
| **provider** | runner の種別 (`claude` / `codex`) |
| **runtime_phase** | LLM 呼出単位。7 種 (`plan`, `plan_verify`, `plan_fix`, `implement`, `review`, `supervise`, `fix`) |
| **workflow ステップ** | state-machine の active state 単位。9 種 = runtime_phase 7 + GitHub 操作 2 (`ci_wait`, `merge`) |
| **state** | task の状態。12 種（active 9 + waiting 1 (`paused`) + terminal 2 (`merged`/`failed`)） |
| **prompt-contract** | runner 出力を構造化するスキーマ。runtime_phase 1:1 対応 |
| **AgentRunInput / AgentRunOutput** | runner の I/O 型。`packages/core/src/runner-contract.ts` |
| **failure.code** | paused / failed の理由を分類する固定列挙。`packages/core/src/failure-codes.ts` |
| **review_round** | レビュー反復回数 |
| **ci_fix_round** | CI 失敗→fix 反復回数 |
| **plan_round** | plan ↔ plan_verify ↔ plan_fix 反復回数 |
| **head SHA gate** | auto-merge 予約 / cleanup 直前に PR head SHA と tasks.yaml の一致を確認する仕組み |
| **sanitize** | 永続化 / 投稿前に機微情報を削除する処理。SPEC §4.6.2 |
| **HMAC 監査** | sanitize 通過を `audit-hmac-key` で署名する仕組み |
| **EX_TEMPFAIL (75)** | POSIX 上の「再実行可能な失敗」を表す終了コード |
| **need_input** | runner が回答待ちで停止した状態を表す `AgentRunStatus` |
| **prompt contract asset** | `.agents/prompts/<contract>.md` |
| **provider link** | `.claude/{agents,skills}` / `.codex/{agents,skills}` から `.agents/` への symlink |
| **backup blacklist** | `init` 時にバックアップしないパス集合 |
| **active task** | `merged` / `failed` 以外の state を持つ task |
| **terminal state** | `merged` / `failed` |
| **waiting state** | `paused` |
| **force-detach** | merge 済みで後始末未完了の task を安全条件確認後に手動完了させる操作 |

## 略号

| 略号 | 展開 |
|------|------|
| `WF` | workflows パッケージ |
| `CR` | claude-runner |
| `CXR` | codex-runner |
| `SHA` | git commit SHA |
| `TUI` | text user interface (Ink ベース) |
| `HMAC` | Hash-based Message Authentication Code (SHA256) |
| `EX_TEMPFAIL` | POSIX exit code 75 (recoverable failure) |

## 詳細定義

正典は [SPEC §1.4](../SPEC.md)。本ガイドの用語と SPEC が食い違ったら **SPEC が正**。
