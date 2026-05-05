# agent-autokit ドキュメント

> docsify Web 表示時のホーム。GitHub 直読でも同じ内容。Web 版起動: リポジトリルートから `npx docsify-cli serve .` で起動し `http://localhost:3000/guides/` を開く。

`agent-autokit` のドキュメントは「使う側」と「読む側」の 2 系統に分離。仕様 / アーカイブ / 参考資料の正典は `../docs/` にある。

## ガイド

| 入口 | 対象 | 内容 |
|------|------|------|
| [`user/`](./user/README.md) | 動かす人 | install / コマンド / config / 観測される振舞 / 復旧手順 |
| [`dev/`](./dev/README.md) | コードを読む人・拡張したい人 | 設計意図 / 内部アーキテクチャ / 状態機械の不変条件 / prompt-contract / 安全設計の境界 |

責務分担:

- **user/** = 観測可能な振舞（コマンド・config キー・log 場所・終了コード・`failure.code` 名）の正典
- **dev/** = 内部不変条件・遷移詳細・`gh` 引数・field 名・package 構造の正典

同じ概念を両方で扱う場合、片側を正典として他方からは link 誘導する。冗長記述を見つけたら正典側へ集約する。

## 仕様正典

- [`../docs/SPEC.md`](../docs/SPEC.md) — 形式仕様（state 遷移表・failure code 列挙・sanitize 規則）
- [`../docs/PLAN.md`](../docs/PLAN.md) — ロードマップ

ガイドが概念で詰まったら必ず SPEC を当たる。実装が SPEC と乖離していたら実装が正、SPEC を更新する。

## 補助資料・アーカイブ

仕様置き場 `../docs/` 配下:

- [`../docs/references/`](../docs/references/) — Phase1〜3 詳細実装計画 / spike 結果 / release 検証環境
- [`../docs/archive/codex-exec-migration/`](../docs/archive/codex-exec-migration/) — Codex SDK → `codex exec` CLI 切替の閉結記録
- [`../docs/artifacts/`](../docs/artifacts/) — issue 検証 evidence (JSON)

GitHub 上で参照する場合:

- [References (GitHub)](https://github.com/cattyneo/agent-autokit/tree/main/docs/references)
- [Archive (GitHub)](https://github.com/cattyneo/agent-autokit/tree/main/docs/archive)

## 内部開発者向け規約

リポジトリのルート [`AGENTS.md`](https://github.com/cattyneo/agent-autokit/blob/main/AGENTS.md ":target=_blank") を参照。

## 構造変更のお知らせ

2026-05-05: docsify サイトを `docs/` 配下から `/guides/` へ切り出し。`docs/` は SPEC.md / PLAN.md / references / archive / artifacts のみの仕様置き場に。docsify は alias で旧パス (`/user-guide` `/dev-guide` `/guides/user` `/guides/dev`) を新 `/user` `/dev` へ救済。GitHub Pages 配信は **リポジトリルート (`/`)** から行う前提で `../docs/SPEC.md` 相対参照が解決する。
