# Phase 4: skills / prompts / agents 品質向上

## ステータス

- バージョン: v0.2.0+ (Phase 4)
- 関連: `docs/references/agent-autokit_phase1-3_implementation_plan.md` §「Phase 4: skills / prompts / agents 品質向上」
- 既存 SPEC との関係 (引用のみ、改変なし):
  - `../SPEC.md#83-同梱-skill-normative-仕様-sot-参照` (`autokit-implement` / `autokit-question` / `autokit-review` skill の SoT は `packages/cli/assets/skills/`)
  - `../SPEC.md#93-prompt_contract-schema` (構造化出力 schema は不変)
  - `../SPEC.md#943-prompt_contract-ファイル配置` (1:1 対応 / 配置 SoT)
- 関連 issue / PR: TBD

注: 本 Phase は autokit を **使う** オペレーター作業手順。同梱 asset の SoT は `packages/cli/assets/skills/autokit-{implement,question,review}` (CLAUDE.md / SPEC §8.3 準拠)。

## 観測可能な完了条件 (AC)

計画書「Phase 4 完了条件 (観測可能)」をそのまま転記。

- [ ] `packages/cli/assets/prompts/*.md` の実 prompt asset が prompt_contract mapping と visibility marker gate を通過し、fixture payload が `runner-contract.test.ts` の `validatePromptContractPayload` を全 phase 通過
- [ ] `autokit-implement` / `autokit-review` skill が `runner-visibility.test.ts` fixture で緑
- [ ] prompt 改善 PR が `prompt_contract` schema 不変 (構造化出力フィールド diff なし) を CI で検証

## 1. skills 品質向上

### 1.1 原則

- ステップで意図された挙動や契約を変えない (`prompt_contract` structured-output 不変、SPEC §9.3)
- スキルは **指示が肥大化する時、同じ指示を複数ステップで使い回す場合に限って利用する**。それ以外は prompt 内に直接書く

### 1.2 修正案

| 同梱 skill | コピー元 (commit hash で pin) | 調整方針 |
|---|---|---|
| `autokit-implement` | 既存 `tdd-workflow` | 本ツールに合わせて調整 (TDD step + autokit prompt_contract への適合) |
| `autokit-review` | 既存 `general-review` | 本ツールに合わせて調整 (review 軸 + supervisor 連携) |
| `autokit-question` | (コピー元なし、autokit 固有) | v0.2.0 では `status=need_input` プロトコル定義のみで構造維持。改修対象外 (理由: SPEC §1.4 / §13.1 で AC 既存、prompt_contract と 1:1 結合済) |

> **コピー元バージョン**: PR 内で commit hash を明記し、上流更新時の同期義務を `CONTRIBUTING` に記載

### 1.3 不変条件 (CI 検証)

- skills 改修 PR は `runner-visibility.test.ts` fixture で緑
- skills 改修で `prompt_contract` 構造化出力フィールドの diff が出ないこと (CI で検証)
- 具体 gate (本書 §2.1 と整合): `codexPromptContractJsonSchema` の **JSON snapshot test** を `packages/codex-runner/src/index.test.ts` に追加する。`codexPromptContractJsonSchema` は現状 private helper なので、テストは同 package 内に置くか、schema builder を明示 export する方針を実装 PR で固定する。skills / prompts 改修 PR で snapshot diff が出たら fail

## 2. prompt 品質向上

### 2.1 不変条件 + CI gate

**重要**: prompt-contract structured-output schema は **不変** (SPEC §9.3)。Phase 4 の改善は **自由記述部 (rationale / steps / constraints) のみ**。

「基本形」セクションは参考であり、出力の `## Result / ## Evidence / ## Changes / ## Test results` は既存 prompt-contract の構造化出力フィールドと **mapping 表で対応** (mapping 表は実装 PR で添付)。

**CI gate 具体化** (本書 §1.3 と整合):

| gate | 配置 | 検出対象 |
|---|---|---|
| `codexPromptContractJsonSchema` JSON snapshot | `packages/codex-runner/src/index.test.ts` 追加、または schema builder 明示 export 後に runner contract test へ配置 | `data` schema / `question` schema / null union / plan-verify anyOf 等の strict schema diff |
| prompt asset scanner + 構造化領域マーカー diff | `runner-visibility.test.ts` 拡張 | base prompt (`packages/cli/assets/prompts/*.md`) と bundled preset の effective prompt set (`packages/cli/assets/presets/*/prompts/**/*.md` を base に overlay した結果) を列挙し、prompt_contract mapping 表と対応する `## Result` / `## Evidence` / `## Changes` / `## Test results` セクション存在 + 順序。既存 prompt に marker が不足する場合、gate 追加 PR が最小 marker 正規化も同 PR で行い、gate-only red PR を作らない |
| `validatePromptContractPayload` 全 phase pass | 既存 `runner-contract.test.ts` (現状そのまま) | runner 受理 payload の意味論検証 |

prompt 改善 PR / skills 改修 PR / bundled preset prompt 追加 PR は **3 つの gate すべてが緑** であること。asset scanner は fixture payload だけでなく実 prompt file と preset-effective prompt を読むため、prompt asset 破損が schema snapshot だけで green になる状態を禁止する。snapshot diff 検出時は (a) schema 改訂を意図する場合 SPEC §9.3 同 PR 更新、(b) 意図しない場合は prompt 自由記述部に閉じ込めるよう改修して再 commit、いずれかを必須とする。

### 2.2 設定ポイント

全て書く必要はない、必要なものだけ簡潔。

| 観点 | 書くこと |
|---|---|
| 今回のタスク | 「何をするステップか」を冒頭で短く |
| 参照元 | 優先順位を明示 |
| 実行手順 | 番号付き actions |
| 条件分岐 | runtime 状況ごとの判断 |
| 検証義務 | build / test / functional check の実施範囲 |
| 失敗時の扱い | 「未確認なら成功扱いしない」等 |
| 変数の活用 | `{report:plan.md}` 等 runtime 変数 |

> 参考 (付録): takt facets/instructions

### 2.3 self-correction retry との整合

`prompt_contract_violation` 検出時の self-correction retry (`phase1-core-cli-runner.md` §7.3) で、prompt 自由記述部の改善が retry 1 回で収束することを fixture で検証する。

## 3. agents 品質向上

### 3.1 設定ポイント

全て書く必要はない。

| 観点 | 書くこと |
|---|---|
| 役割 | 1 文で定義 |
| 責務範囲 | Do / Don't |
| 判断基準 | 行動原則 |
| 権限境界 | 編集可否 / 1 agent = 1 responsibility |
| Source of Truth | 一次情報 |
| AI 癖の禁止 | 推測 / 不要互換 / 未使用コード / fallback 乱用 |
| 出力形式は薄く | prompt 側 + 構造化出力で制御 |

> 参考 (付録): takt facets/personas

### 3.2 既存 agents (`packages/cli/assets/agents/`)

| agent | 役割 (SPEC §1.4 / §2.2 由来) |
|---|---|
| `planner` | プラン作成 (Claude) |
| `plan-verifier` | プラン検証 (Codex) |
| `implementer` | コード編集 + テスト (Codex)、git/PR 操作禁止 |
| `reviewer` | レビュー (Claude) |
| `supervisor` | レビュー妥当性判断 + 修正方針生成 (Claude) |
| `doc-updater` | docs 更新委譲先 (`autokit-implement` skill から呼出、独立 phase なし)。実装変更に伴う docs 更新が必要な場合のみ implement / fix の write_worktree 境界内で動く |

各 agent の「権限境界」と「責務範囲」は Phase 1 capability table (`phase1-core-cli-runner.md` §1) と整合させる:

- `implementer` / `fix` (= write profile 相当) は worktree 内のみ書込可 (SPEC §11.4)
- `doc-updater` は独立 read-only phase ではなく、implement / fix 内の限定委譲先。書込先は docs / guide / spec / README 等の documentation path に限定し、git/PR 操作は禁止
- `planner` / `plan-verifier` / `reviewer` / `supervisor` は read-only (SPEC §11.4.3 + 本 Phase capability table)

## 将来拡張 / 残課題

- skills のコピー元 (`tdd-workflow` / `general-review`) の上流更新を取込む同期作業フロー (`CONTRIBUTING` 記載) は Phase 4 完了後の運用で確立
- agent 増設 (例: `security-reviewer` / `e2e-runner`) は v0.3.0+ で検討。capability table への登録と SPEC §2.2 への追加が前提
