# agent-autokit ドキュメント

> このページは docsify Web 表示時のホームでもある。GitHub 直読でも同じ内容。Web 版起動: `npx docsify-cli serve docs`

`agent-autokit` のドキュメントは「使う側」と「読む側」の 2 系統に分離。

## 系統

| 入口 | 対象 | 内容 |
|------|------|------|
| [`user-guide/`](./user-guide/README.md) | 動かす人 | install / コマンド / config / 観測される振舞 / 復旧手順 |
| [`dev-guide/`](./dev-guide/README.md) | コードを読む人・拡張したい人 | 設計意図 / 内部アーキテクチャ / 状態機械の不変条件 / prompt-contract / 安全設計の境界 |

責務分担:

- **user-guide** = 観測可能な振舞（コマンド・config キー・log 場所・終了コード・`failure.code` 名）の正典
- **dev-guide** = 内部不変条件・遷移詳細・`gh` 引数・field 名・package 構造の正典

同じ概念を両方で扱う場合、片側を正典として他方からは link 誘導する。冗長記述を見つけたら正典側へ集約する。

## 仕様正典

- [`SPEC.md`](./SPEC.md) — 形式仕様（state 遷移表・failure code 列挙・sanitize 規則）
- [`PLAN.md`](./PLAN.md) — ロードマップ
- [`spec_plan_codex_exec_revision_instructions.md`](./spec_plan_codex_exec_revision_instructions.md) — codex_exec 周辺の改修指示
- [`codex_exec_migration_plan.md`](./codex_exec_migration_plan.md) — 移行計画

ガイドが概念で詰まったら必ず SPEC を当たる。実装が SPEC と乖離していたら実装が正、SPEC を更新する。

## 内部開発者向け規約

リポジトリのルート [`AGENTS.md`](../AGENTS.md) を参照。
