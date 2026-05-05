# 06. 用語集

> 最低限。詳細定義は SPEC §1.4。

| 用語 | 意味 |
|------|------|
| **runtime** | `autokit run` の処理本体。子プロセス + state-machine + persistence の総体 |
| **runner** | 子プロセス起動の薄いラッパ。Claude / Codex の 2 種 |
| **provider** | runner の種別 (`claude` / `codex`) |
| **phase / runtime_phase** | 1 ステップの種類。7 種 (`plan`, `plan_verify`, `plan_fix`, `implement`, `review`, `supervise`, `fix`) |
| **state** | task の状態。12 種（active 9 + waiting 1 + terminal 2）。[03-state-machine.md](./03-state-machine.md) |
| **prompt-contract** | runner 出力を構造化するスキーマ。phase 1:1 対応。[04-prompt-contract.md](./04-prompt-contract.md) |
| **AgentRunInput / AgentRunOutput** | runner の I/O 型。`packages/core/src/runner-contract.ts` |
| **failure.code** | paused / failed の理由を分類する固定列挙。SPEC §4.2.1.1 |
| **review_round** | レビュー繰返し回数 (≤ `config.review.max_rounds`) |
| **ci_fix_round** | CI 失敗→fix 繰返し回数 (≤ `config.ci.fix_max_rounds`) |
| **plan_round** | plan ↔ plan_verify ↔ plan_fix 反復 (≤ `config.plan.max_rounds`) |
| **head SHA gate** | auto-merge 予約 / cleanup の前に PR head SHA と tasks.yaml の一致を確認する仕組み。[05-safety.md](./05-safety.md) |
| **sanitize** | 永続化 / 投稿前に機微情報を削除する処理。SPEC §4.6.2 |
| **HMAC 監査** | sanitize 通過を `audit-hmac-key` で署名し改竄検知可能にする仕組み |
| **EX_TEMPFAIL (75)** | resumable error の終了コード。CI でリトライ判別に使う |
| **need_input** | runner が回答を求めて停止した状態。`paused` + `failure.code=need_input_pending` |
| **prompt contract asset** | `.agents/prompts/<contract>.md`。phase ごとの runner 向け指示文 |
| **provider link** | `.claude/{agents,skills}` / `.codex/{agents,skills}` から `.agents/` への symlink |
| **backup blacklist** | init 時にバックアップしないパス。認証ファイル誤バックアップ防止 |
| **active task** | `merged` / `failed` 以外の state。`autokit run` の処理対象 |
| **terminal state** | `merged` / `failed`。runtime_phase は null |
| **waiting state** | `paused`。人手復帰前提 |
| **force-detach** | merge 済みなのに後始末未完了の task を、安全条件確認後に手動完了させる操作 |

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
