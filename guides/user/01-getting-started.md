# 01. はじめに

> この章で解決すること: 何ができるツールか把握 / 必要環境を満たす / インストールと初回 `autokit init` まで完了させる。

## このツールが何をするか

`agent-autokit` は GitHub Issue を起点に、plan → implement → review → CI → auto-merge → cleanup のパイプラインを **ローカルで** 走らせる runtime。Claude CLI / Codex CLI を runner として呼び出し、issue を 1 件取り、PR を作り、レビューを通し、auto-merge を予約し、merge 後に worktree / branch を後片付けるまでを一連の状態機械で進める。

特徴:

- runner は **Claude（read-only）と Codex（workspace-write）** に役割分担される
- 各フェーズの結果は YAML/Markdown で `.autokit/` 配下に永続化され、中断しても再開可能
- Auto-merge は head SHA 一致を必ず確認するため、レビュー後の追加 push を黙って merge しない
- API key を環境変数に出さず、CLI の subscription/auth 状態を使う

ユースケース:

- バックログの量産 issue（typo 修正・小機能追加・依存更新など）を半自動でこなす
- 個人 / 小チームで「1 イシュー → 1 PR → merge」をシリアル処理する

## 前提環境

| 項目 | 要件 |
|------|------|
| OS | Apple Silicon macOS |
| package manager | `bun@1.3.13` |
| `gh` 認証 | `gh auth status` が PASS、`repo` / `workflow` 権限あり |
| `claude` CLI | `claude --version` が動く（subscription 認証済み） |
| `codex` CLI | `codex --version` が動く（subscription 認証済み） |
| repository | `cattyneo/agent-autokit-e2e-fixture` 系のレイアウトに近いもの |

**禁止項目（doctor が FAIL する）:**

- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` のいずれかを export している
- cwd 配下の `.env*` に上記 API key 行が記載されている

```bash
unset ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY
```

`~/.codex/auth.json` や `$CODEX_HOME/auth.json` を読むのも禁止（[`AGENTS.md`](https://github.com/cattyneo/agent-autokit/blob/main/AGENTS.md ":target=_blank") の Safety 節）。

## インストール

`agent-autokit` は private MVP。次の 2 経路のみサポート。

### 経路 A: Release Tarball

```bash
cd /path/to/agent-autokit
bun run build
cd packages/cli
bun pm pack
npm i -g ./cattyneo-autokit-0.1.0.tgz
autokit --version
# => autokit 0.1.0
```

### 経路 B: Checkout Link（開発時）

```bash
cd /path/to/agent-autokit
bun install
bun run build
cd packages/cli
bun link

cd /path/to/target-repo
bun link @cattyneo/autokit
autokit --version
```

詳細・release verification 手順は [`README.md`](../../README.md) の Release Verification セクションを参照。

## 初回診断

対象 repository に `cd` し、まず環境チェック:

```bash
autokit doctor
```

実行例（PASS のとき）:

```
PASS	git repo	ok
PASS	gh auth	ok
PASS	env unset	API keys are not exported
PASS	cwd .env	no API keys found
WARN	config	.autokit/config.yaml not found
WARN	prompt contracts	.agents/prompts not found
```

`init` 前は `config` と `prompt contracts` が `WARN` になるのが正常。`FAIL` が一つでもあれば `init` も `run` もしないこと。

## 初回 init

```bash
autokit init
```

`init` は確認プロンプトを持たないため `-y` 不要（指定しても no-op）。

これで生成される主なもの:

- `.autokit/config.yaml`（version: 1, parallel: 1, auto_merge: true）
- `.autokit/tasks.yaml`（空）
- `.autokit/audit-hmac-key`（監査ログ署名鍵、mode 0600、再生成厳禁）
- `.agents/{agents,skills,prompts}/`
- `.claude/{agents,skills}` / `.codex/{agents,skills}` から `.agents/` への symlink
- `AGENTS.md` / `CLAUDE.md` 末尾に `<!-- autokit:init:start -->` ブロック追記

`.autokit/init-audit.jsonl` は **init が rollback されたときのみ** 残る監査ログ。正常完了時は削除される。

dry-run で内容確認のみ:

```bash
autokit init --dry-run
```

過去の中途失敗 backup（`.autokit/.backup/<timestamp>/` 残留）がある場合のみ:

```bash
autokit init --force
```

ファイル構造の詳細は [04-configuration.md](./04-configuration.md) を参照。

## 次のステップ

実際に 1 issue を流す手順は [02-quickstart.md](./02-quickstart.md) へ。
