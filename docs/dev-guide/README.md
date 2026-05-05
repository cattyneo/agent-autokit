# 開発者ガイド

`agent-autokit` の **設計意図** と **構造** を、SPEC を頭から読まずに把握するための短い解説集。視覚優先・要点のみ。

## 想定読者

- コードを読む / 拡張する開発者
- 「なぜこの状態機械なのか」「なぜ Claude/Codex を分離したのか」を理解したい人
- v0.2 以降に手を入れる前提で実装意図を掴みたい人

`autokit` を **使う** 側の手順は [user-guide](../user-guide/README.md) を参照。本ガイドは「使い方」「コマンド引数」「config フィールド一覧」を再掲しない。

## 構成

| # | ファイル | 内容 | 中心となる図 |
|---|---------|------|--------------|
| 1 | [01-design-intent.md](./01-design-intent.md) | 設計上の決断と却下した代替案 | 表 |
| 2 | [02-architecture.md](./02-architecture.md) | monorepo / 依存 / データフロー | flowchart, sequenceDiagram |
| 3 | [03-state-machine.md](./03-state-machine.md) | state 遷移と不変条件 | stateDiagram |
| 4 | [04-prompt-contract.md](./04-prompt-contract.md) | runner ↔ workflow の契約 | flowchart |
| 5 | [05-safety.md](./05-safety.md) | API key / auto-merge / sandbox / sanitize | flowchart |
| 6 | [06-glossary.md](./06-glossary.md) | 用語の最低限。SPEC §1.4 へ誘導 | — |

## 読み方の順序

最短: `01 → 02 → 03`。残りは必要に応じて拾い読みでよい。

`02` を読み終えたら **コードを並走で開く** ことを推奨。本ガイドは抽象化された全体像を提供するもので、関数単位の挙動はソース直読が早い。
