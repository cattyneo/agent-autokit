# 05. ワークフロー

> この章で解決すること: `autokit run` が内部で何をしているのか、各フェーズで誰（Claude / Codex）が動くのか、auto-merge ガードはどう働くのかを把握する。

正典: [`docs/SPEC.md`](../SPEC.md) §5（state 遷移）/ §2.2（Phase × Provider）/ §4.5（レビュー Markdown）。本章はユーザーが「どこで何が起きうるか」を読むための要約。

## 全体像

```
                   add
                    │
                    ▼
                ┌────────┐
                │ queued │
                └───┬────┘
                    │ run
                    ▼
               ┌──────────┐
       ┌──────►│ planning │
       │       └────┬─────┘
       │            │  plan ↔ plan_verify ↔ plan_fix
       │            │  最大 plan.max_rounds (4)
       │            ▼
       │      ┌─────────┐
       │      │ planned │
       │      └────┬────┘
       │           ▼
       │   ┌──────────────┐
       │   │ implementing │  Codex workspace-write
       │   └──────┬───────┘
       │          ▼
       │     ┌───────────┐
       │     │ reviewing │  Claude review → supervise
       │     └────┬──────┘
       │          │  findings あり → fixing
       │          │  かつ review_round < max_rounds
       │          │
       │          ├──── findings あり → ┌─────────┐
       │          │                     │ fixing  │ Codex
       │          │                     └────┬────┘
       │          │                          │
       │          │   ◄──────────────────────┘
       │          ▼
       │     ┌────────────┐
       │     │ ci_waiting │  GitHub status checks
       │     └────┬───────┘
       │          │
       │          │  CI 失敗 → fixing (ci_fix_round++)
       │          │  かつ ci_fix_round < ci.fix_max_rounds
       │          │
       │          ▼
       │     ┌─────────┐
       │     │ merging │  auto-merge 予約 → 確定確認
       │     └────┬────┘
       │          ▼
       │     ┌──────────┐
       │     │ cleaning │  branch / worktree / 監査
       │     └────┬─────┘
       │          ▼
       │      ┌────────┐
       │      │ merged │
       │      └────────┘
       │
       └─── どの状態からも paused / failed への遷移あり
```

## フェーズ × Provider

各 `runtime_phase` のデフォルト割り当て:

| runtime_phase | provider | sandbox | 役割 |
|---------------|----------|---------|------|
| `plan` | Claude | read-only | issue 本文と現状から plan.md を起こす |
| `plan_verify` | Codex | workspace-write | plan.md の妥当性を Codex 側で検証 |
| `plan_fix` | Claude | read-only | plan_verify の指摘を反映 |
| `implement` | Codex | workspace-write | worktree 上で実装し commit / push / PR draft |
| `review` | Claude | read-only | PR diff を読み findings を出す |
| `supervise` | Claude | read-only | findings を deduplicate / 取捨選択 |
| `fix` | Codex | workspace-write | findings を反映する diff を書く |

`config.yaml` の `phases.<name>.provider` で個別上書き可能。

## state ↔ runtime_phase の対応

`autokit run` のメインループ（`packages/cli/src/executor.ts`）が state を見て対応するワークフローを呼ぶ:

| state | 呼ばれるワークフロー |
|-------|---------------------|
| `queued` / `planning` | `runPlanningWorkflow`（plan / plan_verify / plan_fix を内部反復） |
| `planned` / `implementing` | `runImplementWorkflow`（worktree 確保 → Codex 実装 → push → PR draft） |
| `reviewing` | `runReviewSuperviseWorkflow`（review → supervise → findings 確定） |
| `fixing` | `runFixWorkflow`（findings 反映） |
| `ci_waiting` | `runCiWaitWorkflow`（GitHub status check ポーリング） |
| `merging` | `runMergeWorkflow`（auto-merge 予約 → 確定検知） |
| `cleaning` | `runCleaningWorkflow`（branch / worktree / 監査） |

メインループは最大 100 step までで、terminal（`merged` / `failed`）または waiting（`paused`）に達したら抜ける。

## レビューループ

- 1 ラウンド = `review` → `supervise` → 必要なら `fix`
- 上限: `config.review.max_rounds`（デフォルト 3）
- `warn_threshold`（デフォルト 2）以降のラウンドはログレベル warn でマーク
- 各ラウンドの成果物は `.autokit/reviews/issue-{N}-review-{round}.md` に YAML frontmatter + JSON findings として永続化される
- supervisor が「却下」した finding は次ラウンドに伝播するが sanitize 規則（[`docs/SPEC.md`](../SPEC.md) §4.6.2）に従って round 越え redact される

## CI / fix ループ

- `ci_waiting` で `ci.poll_interval_ms` ごとに `gh pr view --json statusCheckRollup` を実行
- 全 status が `COMPLETED` かつ `SUCCESS` / `SKIPPED` のみ → success → `merging`
- 1 つでも失敗 → failure → `fixing`（`ci_fix_round++`）
- `ci_fix_round` が `ci.fix_max_rounds`（デフォルト 3）に達したら `paused` (`ci_fix_exhausted` 系)
- `ci.timeout_ms`（30 分）超過は `ci.timeout_action`（デフォルト `paused`）に従う

## auto-merge ガード（重要）

`merging` フェーズでは GitHub の auto-merge 機能を使うが、**reserve するときに head SHA を必ず指定**する:

1. `gh pr view <N>` で現在の `headRefOid` を取得
2. tasks.yaml に保存された `pr.head_sha` と照合
3. 一致したら `gh pr merge --auto --squash --match-head-commit <SHA>` で予約
4. 不一致なら `merge_sha_mismatch` failure で `paused`

これにより「review 後に攻撃者が push した別 SHA を auto-merge してしまう」事故を防ぐ。

`gh` 自体に auto-merge 予約後の head 変更時の挙動の差分があるため、念のため `merging` 中も poll し、最終的に `pr.merged === true` かつ `pr.headRefOid === task.pr.head_sha` を確認してから `cleaning` に移る。

## cleaning フェーズ

実行内容:

1. `merge.branch_delete_grace_ms`（デフォルト 5 秒）待機
2. `git push origin --delete <branch>`
3. `git worktree remove --force <path>`（`merge.worktree_remove_retry_max` まで再試行）
4. `git worktree prune`
5. 監査イベント `branch_deleted` 発行

途中で失敗すると `paused` に落ちて `failure.code` が:

- `branch_delete_failed` または
- `worktree_remove_failed`

このときは [`autokit cleanup --force-detach <issue>`](./03-commands.md#autokit-cleanup) で precondition 確認のうえ手動完了させる。

## ペーパートレイル

各 run で生成・更新されるアーティファクト:

| パス | 内容 |
|------|------|
| `tasks.yaml` | atomic write された state |
| `<task.plan.path>` | plan フェーズが書く Markdown（issue ごとに 1 ファイル） |
| `.autokit/reviews/issue-{N}-review-{round}.md` | review round ごとの findings |
| `.autokit/logs/*` | 構造化ログ（redact 適用済み） |
| 監査イベント | logger 経由で `auto_merge_reserved` / `auto_merge_disabled` / `branch_deleted` / `sanitize_pass_hmac` 等 |

## 関連

- 復旧手順: [06-recovery.md](./06-recovery.md)
- 設定値の意味: [04-configuration.md](./04-configuration.md)
- 形式定義: [`docs/SPEC.md`](../SPEC.md) §5
