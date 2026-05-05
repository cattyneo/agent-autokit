# agent-autokit

`agent-autokit` は、GitHub Issue を plan / implement / review / CI / merge / cleanup まで進めるためのローカル issue-train runtime です。Claude CLI と Codex CLI を runner として使います。

## v0.1.0 Support Matrix

v0.1.0 は意図的に対象を狭くしています。

- Apple Silicon macOS のローカル実行環境
- `cattyneo/agent-autokit-e2e-fixture` に近い GitHub repository
- `repo` / `workflow` 権限を持つ `gh` 認証
- Claude Code / Codex CLI の subscription auth
- live 実行時に API key 環境変数が unset
- private distribution のみ

汎用 branch protection 設計、SDK runner matrix、public registry publish、広範な repository 互換性は v0.1.0 の対象外です。

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
autokit add 1 --label agent-ready -y
autokit doctor
autokit run
autokit list --json
```

`autokit run` は、対象 work が完了 / merge 済みなら `0`、branch protection / rate limit / runner question など human action が必要な resumable state なら `75` で終了します。

## Release Verification

release 前に次を実行します。

```bash
PATH="$HOME/.bun/bin:$PATH" scripts/check-release-verification-env.sh
```

その後、clean HOME または別マシンで 2 つの private install path を検証します。v0.1.0 の release evidence は `docs/artifacts/` に記録します。
