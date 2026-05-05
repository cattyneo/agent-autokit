# docs/ — 仕様置き場

`agent-autokit` の **仕様正典・補助資料・アーカイブ・検証 evidence** をここに集約する。GitHub 直読での閲覧用。

ユーザーガイド / 開発者ガイド (docsify Web サイト) は [`/guides/`](../guides/) に分離している。

## 正典

- [`SPEC.md`](./SPEC.md) — 形式仕様 (state 遷移表・failure code 列挙・sanitize 規則・lock protocol)
- [`PLAN.md`](./PLAN.md) — ロードマップ・Sprint 細分化

## 補助資料 (`references/`)

- [`references/agent-autokit_phase1-3_implementation_plan.md`](./references/agent-autokit_phase1-3_implementation_plan.md) — Phase1〜3 詳細実装計画
- [`references/spike-results.md`](./references/spike-results.md) — S0 採用判定の検証結果
- [`references/release-verification-environment.md`](./references/release-verification-environment.md) — release 検証環境セットアップ手順

## アーカイブ (`archive/`)

過去の意思決定証跡。SSOT は SPEC.md / PLAN.md。閉結済の議論を辿る用途のみ。

- [`archive/codex-exec-migration/`](./archive/codex-exec-migration/) — Codex SDK → `codex exec` CLI 切替の inventory / plan / review / final-review / 改修指示書

## Evidence (`artifacts/`)

issue 検証時に生成した JSON evidence。生成スクリプト・検証手順は SPEC / PLAN 側を参照。

## ガイドへ

- [`/guides/user/`](../guides/user/README.md) — 動かす側
- [`/guides/dev/`](../guides/dev/README.md) — 読む側

## 内部開発者向け規約

[`AGENTS.md`](https://github.com/cattyneo/agent-autokit/blob/main/AGENTS.md) (リポジトリルート)
