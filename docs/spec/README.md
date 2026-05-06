# agent-autokit 改修仕様書 (docs/spec)

## このディレクトリの位置付け

`docs/SPEC.md` は v0.1.0 凍結 SoT (2435 行、Last Updated 2026-05-05)。本ディレクトリは **v0.2.0+ の改修 SoT** を Phase 単位で保持する。両者は層別 SoT であり、計画書 (`docs/references/agent-autokit_phase1-3_implementation_plan.md`) を機能別に正式化したもの。

| 層 | Path | バージョン | 役割 |
|---|---|---|---|
| 既存仕様 | `docs/SPEC.md` | v0.1.0 | 凍結 SoT。GA 受入基準 (§13) と一体運用 |
| 改修仕様 | `docs/spec/*.md` (本ディレクトリ) | v0.2.0+ | Phase 1〜4 改修の追加 SoT |
| 計画書 | `docs/references/agent-autokit_phase1-3_implementation_plan.md` | (改修計画) | 本ディレクトリの起源 |
| ロードマップ | `docs/PLAN.md` | v0.1.0+ | 段取り (本タスクの対象外) |

`docs/SPEC.md` は本タスクで **移動も内容修正もしない**。新 `failure.code` / audit kind / `TransitionEvent` は実装 PR (`packages/core/src/failure-codes.ts` 等) と同 PR で SPEC.md §4.2.1.1 / §10.2.2.2 / §5.1 に追記し、`scripts/check-trace.sh` 1:1 trace gate を緑化する責務 (`cross-cutting.md` §4 参照)。

## 章マップ

| 章 | Path | 計画書 § | 既存 SPEC との接点 |
|---|---|---|---|
| 横断仕様 | `cross-cutting.md` | 「実装順序」「主なリスクと対策」 | §4.2.1.1, §5.1, §10.2.2, §11.6 (引用のみ) |
| Phase 1 | `phase1-core-cli-runner.md` | §1〜§9 (Phase 1) | §1.4, §2.2, §4.1, §4.2, §5.1, §9.5, §10.2, §11.4 |
| Phase 2 | `phase2-serve-dashboard.md` | Phase 2A / Phase 2B | §11.5, §11.6 |
| Phase 3 | `phase3-preset.md` | Phase 3 §1〜§4 | §11.5 |
| Phase 4 | `phase4-quality.md` | Phase 4 §1〜§3 | §8.3, §9.3 |

## 計画書 ↔ docs/spec トレーサビリティ

| 計画書 § | docs/spec 章 |
|---|---|
| 「目的」「基本方針」 | `README.md` (本書) + `phase1-core-cli-runner.md` 冒頭 |
| Phase 1 §1 Capability table | `phase1-core-cli-runner.md` §1 |
| Phase 1 §2 Provider 自由切替 | `phase1-core-cli-runner.md` §2 |
| Phase 1 §3 Effort policy | `phase1-core-cli-runner.md` §3 |
| Phase 1 §4 Config / Runtime / Tasks | `phase1-core-cli-runner.md` §4 |
| Phase 1 §5 Runner 更新 | `phase1-core-cli-runner.md` §5 |
| Phase 1 §6 CLI override | `phase1-core-cli-runner.md` §6 |
| Phase 1 §7 Review/Fix loop | `phase1-core-cli-runner.md` §7 |
| Phase 1 §8 CLI 追加 | `phase1-core-cli-runner.md` §8 |
| Phase 1 §9 sanitize / redact | `phase1-core-cli-runner.md` §9 |
| Phase 2 §1 `autokit serve` | `phase2-serve-dashboard.md` §1 |
| Phase 2 §2 Dashboard | `phase2-serve-dashboard.md` §2 |
| Phase 3 §1 Preset 構造 | `phase3-preset.md` §1 |
| Phase 3 §2 Preset Commands | `phase3-preset.md` §2 |
| Phase 3 §3 Apply 安全制約 | `phase3-preset.md` §3 |
| Phase 3 §4 初期 Preset | `phase3-preset.md` §4 |
| Phase 4 §1 skills | `phase4-quality.md` §1 |
| Phase 4 §2 prompts | `phase4-quality.md` §2 |
| Phase 4 §3 agents | `phase4-quality.md` §3 |
| 実装順序 | `cross-cutting.md` §5 |
| 主なリスクと対策 | `cross-cutting.md` §6 |

## 各仕様書の必須セクション

すべての `docs/spec/*.md` は以下を含む:

- **ステータス**: バージョン / 関連計画書 § / 既存 SPEC との関係 (引用のみ) / 関連 issue / PR
- **観測可能な完了条件 (AC)**: 計画書の「Phase N 完了条件」を転記し、`scripts/check-trace.sh` / `scripts/check-assets-hygiene.sh` の緑化必須を追記
- **将来拡張 / 残課題**: 計画書の Phase 3+ 後置項 / Phase 2B / 段階導入オプションを移送

## 参照先 anchor (SPEC.md)

本ディレクトリから引用する SPEC.md anchor の代表:

- `../SPEC.md#14-用語` (用語: `runtime_phase` / `agent_phase` / `prompt_contract` / `head_sha` / 4 site)
- `../SPEC.md#22-役割分担-phase--provider` (Phase × Provider 表、v0.2.0 で capability table 由来へ移行)
- `../SPEC.md#41-configyaml` (config schema)
- `../SPEC.md#42-tasksyaml` (tasks.yaml schema)
- `../SPEC.md#421-failure-schema` / `../SPEC.md#4211-failurecode-固定列挙`
- `../SPEC.md#51-state-遷移表` (E01〜E40)
- `../SPEC.md#1022-audit-イベント`
- `../SPEC.md#1143-claude-runner-の安全境界` (workspace_scope / allowed_tools / home_isolation / nonce marker)
- `../SPEC.md#115-backup-保管` (`audit-hmac-key` lifecycle)
- `../SPEC.md#116-assets-hygiene-ci`

## SoT 衝突時の解決規則

3 層 SoT (`docs/SPEC.md` / `docs/spec/*.md` / `docs/references/...`) のいずれかが衝突した場合の優先順位:

| 衝突パターン | 優先 SoT | 解決責務 |
|---|---|---|
| `docs/spec/*` ↔ `docs/references/...` (計画書) | `docs/spec/*` | 計画書を update PR で同期 |
| `docs/spec/*` ↔ `docs/SPEC.md` (v0.1.0 既存記述) | **状況依存**: docs/spec が **意図的拡張** (例: phase1 §1.4 deprecate path で v0.2.0 で挙動変更) → `docs/spec/*` 優先 + SPEC.md 同 PR 改訂責務。`docs/spec/*` が SPEC.md の不変条件 (例: §5.1 1 transition = state/runtime_phase 変化) を破壊する場合 → **SPEC.md 優先**、`docs/spec/*` を SPEC §不変条件と整合する記述へ訂正 | 実装 PR で SPEC.md §X.Y を改訂、または docs/spec/* を訂正 |
| deprecate 期間中 (例: `permissions.claude.allowed_tools`) | **両者を満たす実装** | 旧仕様 + 新仕様の union を実装し、deprecate 完了 PR で旧仕様削除 |
| `docs/spec/*` ↔ `CLAUDE.md` / `docs/PLAN.md` | CLAUDE.md / PLAN.md が **運用 / 制約** を定義する場合 (例: CLI subscription auth) → `CLAUDE.md` 優先。`docs/spec/*` が **新機能仕様** を導入する場合 → `docs/spec/*` 優先 + CLAUDE.md / PLAN.md 同 PR 同期 | 実装 PR で同期 |

## 実装ヒント (擬似コード集約)

計画書のコード fence (型シグネチャ / 擬似コード) は本ディレクトリの各仕様書内では型シグネチャのみ抽出する。実装担当が参照する完全な擬似コードは計画書 (`docs/references/agent-autokit_phase1-3_implementation_plan.md`) を SoT として直接参照する。仕様書 (`docs/spec/*.md`) と計画書 (`docs/references/...`) の間に矛盾が生じた場合、**仕様書が優先** し、計画書側を update PR で同期する責務。

## 検証 (本タスク完了時)

- 仕様書のみ追加。実装変更なし → ビルド / テスト不要。
- `bash scripts/check-trace.sh` 緑 (SPEC.md 不変)。
- `wc -l docs/spec/*.md` で過大 (1500 行超) なドラフトがないこと。
- 各 phase ファイル先頭の「ステータス」「観測可能な完了条件」「将来拡張 / 残課題」が揃っていること。
- 計画書 §「実装順序」16 step が `cross-cutting.md` §5 に過不足なく転記されていること。

### 計画書側の継承課題 (本タスク範囲外、別 PR 起票推奨)

- 計画書「実装順序」preamble の「step 13 を user-guide のみに縮小」記述は、実 step 13 (= 初期 preset 追加) と乖離する (user-guide は step 15)。本タスクの仕様書では計画書の表現を継承したが、計画書 update PR で表現を修正することを推奨。
- **SPEC.md / CLAUDE.md / docs/PLAN.md への新 failure.code 追記責務の明文化**: `cross-cutting.md` §4 で実装 PR の同 PR 更新責務を定めるが、`docs/SPEC.md` §4.2.1.1 / §10.2.2 直下、CLAUDE.md (project section)、`docs/PLAN.md` 重要原則に「failure.code / audit kind / TransitionEvent 追加時は同 PR 更新義務 + `scripts/check-trace.sh` 緑化義務」を 1 行追記する **別 PR の起票** を推奨。docs/spec を読まない実装者が CI gate 失敗で初めて気付く事故を回避。
