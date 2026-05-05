# agent-autokit ユーザーガイド

`agent-autokit` を「インストール → 初回実行 → 復旧」まで通しで使うための導線ドキュメント。
仕様の正典は [`docs/SPEC.md`](../../docs/SPEC.md)、リリース注意は [`README.md`](https://github.com/cattyneo/agent-autokit/blob/main/README.md ":target=_blank")、内部開発規約は [`AGENTS.md`](https://github.com/cattyneo/agent-autokit/blob/main/AGENTS.md ":target=_blank") に分離している。本ガイドは「実際にコマンドを叩く側」が読むためのものを集約する。

## 対象読者

- GitHub Issue を `agent-autokit` で自動処理させたい開発者
- Claude Code / Codex CLI の subscription を持っている
- Apple Silicon macOS 環境
- `gh` CLI が `repo` / `workflow` 権限で認証済み

## v0.1.0 制約サマリ

- private MVP。registry 公開なし
- 対象 repository は `cattyneo/agent-autokit-e2e-fixture` 系のレイアウト
- 並列実行は固定 `parallel: 1`
- API key 環境変数（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY`）が **export されていないこと**

詳細は [`README.md`](../../README.md) の Support Matrix を参照。

## 読む順序

| # | ファイル | こんなときに読む |
|---|---------|----------------|
| 1 | [01-getting-started.md](./01-getting-started.md) | 最初にインストールして `autokit init` まで終わらせたい |
| 2 | [02-quickstart.md](./02-quickstart.md) | 1 issue を end-to-end で動かす E2E チュートリアル |
| 3 | [03-commands.md](./03-commands.md) | 各コマンドの引数・オプション・終了コードを引きたい |
| 4 | [04-configuration.md](./04-configuration.md) | `.autokit/` 構造・`config.yaml`・env 変数を確認したい |
| 5 | [05-workflow.md](./05-workflow.md) | 9 ステップ（runtime_phase 7 + ci_wait + merge）の挙動を把握したい |
| 6 | [06-recovery.md](./06-recovery.md) | 終了コード `75` が出た / `paused` から復旧したい |
| 7 | [07-troubleshooting-faq.md](./07-troubleshooting-faq.md) | エラー・FAQ を引きたい |

## 開発者向けガイド

「なぜそうなっているか」「コードの読み方」「拡張方針」は [`dev-guide/`](../dev/README.md) に分離。

## 仕様との関係

本ガイドはユーザー向け概要のみを書く。形式定義（state 遷移表、failure code 一覧、sanitize ルール、ロックプロトコル等）は [`docs/SPEC.md`](../../docs/SPEC.md) を正典とし、必要に応じて該当節へリンクする。

## フィードバック

ガイドの不正確な記述は GitHub Issue にて報告してほしい。コードと乖離した箇所を見つけた場合、`packages/cli/src/index.ts` および `packages/cli/src/init.ts` の実装が正である。
