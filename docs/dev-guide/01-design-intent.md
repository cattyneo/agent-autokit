# 01. 設計意図

> 主要な設計上の決断と、却下した代替案。「なぜそうなっているのか」だけを書く。

## 一覧

| # | 決断 | 却下した代替 | 理由 |
|---|------|--------------|------|
| 1 | **ローカル CLI runtime** | SaaS / GitHub App | subscription 認証を端末で完結。秘密情報が外部に出ない。個人の手元で完結する開発フロー前提 |
| 2 | **Claude (read-only) と Codex (workspace-write) を分離** | 単一 runner / どちらか一方 | 「読む側」と「書く側」を sandbox 上分離 → 設計のミスで write 権限が漏れない。レビュー視点の中立性確保 |
| 3 | **subscription 認証のみ** (`ANTHROPIC_API_KEY` 等は禁止) | API key 併用許容 | 課金経路の二重化を防ぐ。CLI ローカルの auth 状態を一元化 |
| 4 | **9 ステップの細分化** = runtime_phase 7（`plan`/`plan_verify`/`plan_fix`/`implement`/`review`/`supervise`/`fix`） + GitHub 操作 2（`ci_wait`/`merge`） | 「単一の implement→review→merge」 | runtime_phase ごとに provider と prompt を切替可能。失敗時の再開単位を最小化 |
| 4a | **`supervise` フェーズの分離** | review 結果をそのまま採用 | findings の取捨選択を別 prompt に分け、誤検知の伝播を抑える |
| 5 | **`paused` を一級市民化、exit code `75`** | failed のみ | 人手復旧前提のシステムで「再開可能エラー」と「諦め」を区別。CI で「リトライ」できる |
| 6 | **prompt-contract で出力を構造化** | 自由テキスト解釈 | runner の return を `completed`/`need_input`/`paused`/`failed` の構造に強制。誤解釈・幻想 commit を防ぐ |
| 7 | **state を YAML に atomic write** | DB / SQLite | レビュー / 編集容易 / git diff で変更追跡可能。1 マシン前提で十分 |
| 8 | **auto-merge は head SHA を必ず縛る** | `gh pr merge --auto` のみ | review 後の追加 push を黙って merge してしまう事故を排除 |
| 9 | **`audit-hmac-key` で sanitize 監査** | 監査なし / 平文ログ | 永続化 / 投稿前の機微情報 sanitize の通過証跡を残す。鍵を持たない側からは改竄不能 |
| 10 | **`init` は rollback 必須 + backup blacklist** | べき等 in-place 上書き | 失敗時に部分書き込みで repo を破壊しない。認証ファイルを誤バックアップしない |
| 11 | **`parallel: 1` 固定 (v0.1.0)** | 多並列 | 状態機械の不変条件が確認しきれない / 監査ログの順序保証が複雑化 |
| 12 | **monorepo 6 packages** | 単一パッケージ | runner 入れ替え・workflows 単独テストの境界を明示。`core` を runner と独立させる |
| 13 | **TUI を独立パッケージ (`tui`)** | CLI と一体 | TUI を入れ替え可能 / non-TTY 環境でも core ロジックを動かせる |
| 14 | **private MVP / registry 公開無し (v0.1.0)** | 即 OSS 公開 | 仕様未確定 / 安全側の検証が完了するまでは fixture に近い repo に限定 |

## アーキテクチャの形を決めている制約

優先順位（高 → 低）:

```
1. 安全（誤 merge / 漏洩 / 鍵流出 を起こさない）
2. 復旧可能性（任意の点で paused に落とせる / re-entry できる）
3. 観測可能性（YAML / Markdown / JSON 監査で外部から読める）
4. 拡張性（runner / phase / prompt の差替）
5. 利便性（TUI / 自動回答 等）
```

下位の利便性は、上位の安全 / 復旧可能性に劣後する。例: `-y` の auto-answer は質問が無い paused からは抜け出せない（無理に進めない）。

## v0.1.0 を狭くしている理由

`README.md` の Support Matrix に列挙した制約（Apple Silicon / fixture-like repo / parallel 1 等）はすべて **「未検証だから許可しない」** で統一されている。サポート拡大は仕様確認 + テストの追加とセットでしか進めない方針。
