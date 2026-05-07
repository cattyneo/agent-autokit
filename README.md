# agent-autokit

`agent-autokit` は、GitHub Issue を plan / implement / review / CI / merge / cleanup まで進めるためのローカル issue-train runtime です。Claude CLI と Codex CLI を runner として使います。

## v0.1.0 / v0.2.0 Support Matrix

v0.1.0 は意図的に対象を狭くした private MVP です。v0.2.0 は同じ private distribution を前提に、runner capability、effort、preset、local serve API、prompt/skill/agent 品質 gate を追加します。

- Apple Silicon macOS のローカル実行環境
- `cattyneo/agent-autokit-e2e-fixture` に近い GitHub repository
- `repo` / `workflow` 権限を持つ `gh` 認証
- Claude Code / Codex CLI の subscription auth
- live 実行時に API key 環境変数が unset
- private distribution のみ

汎用 branch protection 設計、SDK runner matrix、public registry publish、広範な repository 互換性は v0.2.0 でも対象外です。

v0.2.0 の主な追加 surface:

- `capability` table: 7 agent phase (`plan` / `plan_verify` / `plan_fix` / `implement` / `review` / `supervise` / `fix`) × 2 provider (`claude` / `codex`) を core SoT とし、permission profile は phase から固定導出します。`ci_wait` / `merge` は core-only で runner 対象外です。
- `effort`: `auto` / `low` / `medium` / `high` と `unsupported_policy: fail | downgrade` を config で指定できます。
- `preset`: `autokit preset list|show|apply` で bundled / repo-local preset を扱います。`default` / `laravel-filament` / `next-shadcn` / `docs-create` を同梱します。
- `autokit serve`: bearer / Host / Origin / Content-Type gate 付きの local HTTP API と SSE を提供します。
- `logs` / `diff` / `config show --matrix`: sanitize 済みの運用確認と capability matrix 確認を CLI から実行できます。

## インストール

package は `private: true` のままです。`npm publish` は実行しません。v0.1.0 は private install path として次の 2 経路だけをサポートします。

### Release Tarball

```bash
bun run build
cd packages/cli
bun pm pack
npm i -g ./cattyneo-autokit-0.1.0.tgz
autokit --version
```

### Checkout Link

```bash
bun install
bun run build
cd packages/cli
bun link
cd /path/to/target-repo
bun link @cattyneo/autokit
autokit --version
```

## 必要な認証

API key 環境変数ではなく、CLI の subscription / auth state を使います。

```bash
unset ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY
gh auth status -h github.com
claude --version
codex --version
```

`~/.codex/auth.json` や `$CODEX_HOME/auth.json` の内容を読んだり、logs / artifacts / issues / PRs にコピーしたりしないでください。

## 基本フロー

`autokit` をインストールしたあと、対象 repository で実行します。

```bash
autokit init -y
autokit preset list
autokit preset apply default
autokit config show --matrix
autokit add 1 --label agent-ready -y
autokit doctor
autokit run
autokit list --json
```

`autokit run` は、対象 work が完了 / merge 済みなら `0`、失敗または起動拒否なら `1`、引数構文エラーなら `2`、branch protection / rate limit / runner question / lock busy など human action が必要な resumable state なら `75` で終了します。

### Local serve API

ローカル UI / 外部 coordinator から使う場合は `autokit serve` を起動します。既定 bind は `127.0.0.1`、token は毎起動で再生成され、token file path は標準出力に表示されます。

```bash
autokit serve --host 127.0.0.1 --port 0
# serve listening	http://127.0.0.1:<port>
# token file	.../autokit/serve/<repo-id>/<port>/token
```

mutating endpoint は repository lock を取得できない場合 HTTP 409 (`serve_lock_busy`) を返します。同じ repository で CLI write command を直叩きした場合は exit `75` で fast-fail し、`tasks.yaml` は更新しません。

## ドキュメント

- [`guides/`](./guides/README.md) — ドキュメント入口 (docsify Web サイト)
  - [`guides/user/`](./guides/user/README.md) — インストール・コマンド・設定・復旧
  - [`guides/dev/`](./guides/dev/README.md) — 設計意図・アーキテクチャ・状態機械・prompt-contract・安全設計
- [`docs/`](./docs/README.md) — 仕様置き場
  - [`docs/SPEC.md`](./docs/SPEC.md) — 形式仕様（正典）
  - [`docs/PLAN.md`](./docs/PLAN.md) — ロードマップ
  - `docs/references/` — Phase1〜3 計画 / spike / release 検証環境
  - `docs/archive/` — Codex CLI 移行の閉結証跡
  - `docs/artifacts/` — issue 検証 evidence (JSON)

### Web 表示（docsify）

`/guides/` を docsify サイトとして配信します（mermaid 図がブラウザでレンダリング、user / dev サイドバー切替、検索付き）。SPEC / PLAN は相対リンクで `../docs/SPEC.md` を直接表示できます (リポジトリルートが配信ルートのとき)。

```bash
# ローカル (リポジトリルートから)
npx docsify-cli serve .
# → http://localhost:3000/guides/
```

GitHub Pages 公開時は `Settings → Pages → Branch: main, Folder: / (root)` を設定し、`https://<owner>.github.io/agent-autokit/guides/` を docsify ホームとして使用します (folder=/guides にすると docs/SPEC.md など配信外になり in-page SPEC 表示が壊れるため避ける)。

## Release Verification

release 前に次を実行します。

```bash
PATH="$HOME/.bun/bin:$PATH" scripts/check-release-verification-env.sh
```

その後、clean HOME または別マシンで 2 つの private install path を検証します。v0.1.0 の release evidence は `docs/artifacts/` に記録します。
