# 05. ワークフロー

> この章で解決すること: `autokit run` がどの順序で何をするか、ユーザーから見える区切り（state / runtime_phase）はどう分かれるか、どこで停止しうるかを把握する。

用語整理:

- **runtime_phase（7 種）**: LLM を呼び出す単位 — `plan` / `plan_verify` / `plan_fix` / `implement` / `review` / `supervise` / `fix`
- **workflow ステップ（9 種）**: state-machine の active state — runtime_phase 7 + GitHub 操作のみの `ci_wait` / `merge`

正典: [`docs/SPEC.md`](../../docs/SPEC.md) §5（state 遷移）/ §2.2（Phase × Provider）/ §4.5（レビュー Markdown）。内部不変条件・遷移詳細は [dev-guide/03](../dev/03-state-machine.md)、安全境界は [dev-guide/05](../dev/05-safety.md)。本章はユーザーが「どこで何が起きうるか」を読むための振舞要約。

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

`runtime_phase` ごとの provider / sandbox / 役割の正典は [04-configuration.md](./04-configuration.md) `phases.<phase>` セクション。v0.2.0 では 7 agent phase × 2 provider の capability table が core SoT で、`config.yaml` の `phases.<name>.provider` または `autokit run --phase ... --provider ...` で個別上書きできる。

permission profile は provider ではなく phase から固定導出される:

| profile | phase | 代表権限 |
|---------|-------|----------|
| `readonly_repo` | `plan` / `plan_verify` / `plan_fix` | repo 参照のみ |
| `readonly_worktree` | `review` / `supervise` | worktree 参照のみ |
| `write_worktree` | `implement` / `fix` | worktree 内の編集可 |

`effort` は `auto` / `low` / `medium` / `high`。解決結果は `runtime.resolved_effort` に保存され、unsupported tuple は `effort.unsupported_policy` に応じて `effort_unsupported` で停止または `effort_downgrade` audit を残して downgrade される。

## レビューループ（観測される振舞）

- 1 ラウンド = `review` → `supervise` → 必要なら `fix`
- 上限: `config.review.max_rounds` 回。`review_round + 1 > max_rounds` になった acceptance は `failed` (`failure.code: review_max`) で終端する
- `config.review.warn_threshold` 以降のラウンドは log level warn
- 成果物: `.autokit/reviews/issue-{N}-review-{round}.md`（YAML frontmatter + JSON findings）
- supervisor が却下した finding は sanitize 規則（[`docs/SPEC.md`](../../docs/SPEC.md) §4.6.2）の round 越え redact を経て次ラウンドへ伝播

ループの内部遷移条件・不変条件は [dev-guide/03](../dev/03-state-machine.md) のレビューループ節を参照。

## CI / fix ループ（観測される振舞）

- `ci_waiting` で `config.ci.poll_interval_ms` ごとに status check をポーリング
- 全 status `COMPLETED` かつ `SUCCESS` / `SKIPPED` のみ → `merging`
- 1 つでも失敗 → `fixing` で `ci_fix_round++`
- `ci_fix_round + 1 > config.ci.fix_max_rounds` になった CI failure は `failed` (`failure.code: ci_failure_max`) で終端する
- 経過時間が `config.ci.timeout_ms` 超過 → `config.ci.timeout_action` に従い `paused` (`failure.code: ci_timeout`) または `failed`

`failure.code` 別の対処は [06-recovery.md](./06-recovery.md)。既定値の数値は [04-configuration.md](./04-configuration.md) の `ci.*` フィールド表。

## self-correction retry

prompt-contract 違反は初回だけ同 phase 内で self-correction retry される。`runtime.phase_self_correct_done=false` から `true` へ更新し、audit kind `phase_self_correct` を残す。2 回目も違反した場合は `failure.code=prompt_contract_violation` で停止する。

この retry は state-machine の新 state ではなく、同じ runtime_phase の中で完結する。resume 時は `phase_self_correct_done` を見て二重 retry しない。

## auto-merge

`merging` で GitHub auto-merge を **head SHA を縛って** 予約する。

ユーザーから見える振舞:

- レビュー後に PR へ追加 push が入っていた場合、auto-merge が拒否されて `paused` (`failure.code: merge_sha_mismatch`) になる
- merge 後の cleanup が失敗しても `autokit cleanup --force-detach` が同じ head SHA gate を再評価してから merged 化する

ガードの内部実装（`gh` 引数 / poll 戦略 / `pr.headRefOid` 照合）は [dev-guide/05](../dev/05-safety.md) の auto-merge head SHA gate 節。

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
- 形式定義: [`docs/SPEC.md`](../../docs/SPEC.md) §5
