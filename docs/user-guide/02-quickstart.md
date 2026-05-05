# 02. クイックスタート

> この章で解決すること: 1 issue を `autokit` だけで PR 化 → merge → cleanup まで通す手順を実例で示す。

前提: [01-getting-started.md](./01-getting-started.md) を完了済み（`autokit doctor` が PASS、`autokit init -y` 済み）。

## ステップ 1: 対象 issue を queue に入れる

repository に Open issue が `#10` 〜 `#13` の 4 件あり、いずれも `agent-ready` label がついているとする:

```bash
autokit add 10-13 --label agent-ready -y
```

範囲指定の文法:

| 入力 | 意味 |
|------|------|
| `10` | issue #10 のみ |
| `10-13` | #10, #11, #12, #13 |
| `10,15,20` | カンマ区切りで個別指定（混在可: `10-12,15`） |
| `all` | Open issue を全件取り込み |

期待出力:

```
targets: 4, additions: 4
```

`--dry-run` を付けると tasks.yaml に書き込まずに件数だけ表示する。merged 済みの issue を再投入したい場合のみ `--force`。

queue を確認:

```bash
autokit list
```

```
ISSUE  STATE       RUNTIME_PHASE  PR    BRANCH                    UPDATED
10     queued      -              -     -                         2026-05-05T...
11     queued      -              -     -                         2026-05-05T...
12     queued      -              -     -                         2026-05-05T...
13     queued      -              -     -                         2026-05-05T...
```

機械可読が必要なら `autokit list --json`。

## ステップ 2: ワークフロー実行

```bash
autokit run
```

`run` は queue 先頭の active task を 1 件取り、内部で `plan → plan_verify → plan_fix → implement → review → supervise → fix → ci_wait → merge → cleaning` の状態機械を進める。各フェーズの詳細は [05-workflow.md](./05-workflow.md) を参照。

実行が完了すると次のいずれかで終わる:

| 終了コード | 意味 | 次にすべきこと |
|------------|------|---------------|
| `0` | 全タスクが `merged` に到達 | 何もしない |
| `75` | 1 件以上が `paused` / `cleaning` 等の **resumable state** | 原因に応じて対処後 `autokit resume` |
| `1` | 1 件以上が `failed` または引数エラー | エラーログを見て修正 |

実行途中で runner から `need_input` の質問が出ると `paused` で停まる。TUI で対話的に答えるか、`-y` で auto-answer に委ねる（ただし `-y` は質問内容に応じた合理的判定はせず、デフォルト回答を機械的に投入するだけ）。

## ステップ 3: 状態確認

実行中・実行後に状態を確認:

```bash
autokit list
autokit status     # 現在 active 状態の 1 件を JSON で
```

`status` は `queued` / `merged` / `failed` 以外の状態（実行中・paused 含む）の最初の task を返す。無ければ exit 1。

paused になった理由は `failure.code` で判別可能:

```bash
autokit list --json | jq '.[] | select(.failure != null) | {issue, state, code: .failure.code}'
```

`failure.code` の意味は [`docs/SPEC.md`](../SPEC.md) §4.2.1.1 を参照。代表的なもの:

- `need_input_pending`: runner が質問中。TUI で答えて `autokit resume`
- `merge_sha_mismatch`: PR head SHA 不一致。手動確認が必要
- `retry_cleanup_failed`: cleanup で失敗。`autokit retry` で再走
- `branch_delete_failed` / `worktree_remove_failed`: cleanup の force-detach が必要

## ステップ 4: 復旧（必要な場合）

`autokit run` が `75` で終わった場合、原因が解決したら:

```bash
# 全 paused タスクを最新状態でレジューム判定
autokit resume

# 特定 issue だけ
autokit resume 12
```

`resume` は state を変えるのではなく、最終的な `getWorkflowExitCode` を返す（解決していれば `0`、未解決ならまた `75`）。実態としては `autokit run` を再度実行することで状態機械が再開される。詳細プレイブックは [06-recovery.md](./06-recovery.md) を参照。

## ステップ 5: cleanup

通常は `cleaning` フェーズが自動的に branch / worktree を削除する。auto-cleanup が失敗し、PR は merge 済みなのに残骸が残る（`paused` + `branch_delete_failed` / `worktree_remove_failed`）場合のみ、手動 force-detach:

```bash
# まず precondition だけ評価
autokit cleanup --force-detach 12 --dry-run

# 問題なければ実行（インタラクティブ確認あり）
autokit cleanup --force-detach 12
```

force-detach は PR が `MERGED` かつ head SHA が tasks.yaml と一致していることを `gh pr view` で再確認してから実施する。条件を満たさなければ task を `paused` (`merge_sha_mismatch`) にして拒否する。

## まとめ

```bash
autokit doctor                                  # 環境チェック
autokit init -y                                 # 初期化
autokit add 10-13 --label agent-ready -y        # queue 投入
autokit run                                     # 実行
autokit list --json                             # 状態確認
autokit resume                                  # 必要なら再開
autokit cleanup --force-detach 12               # 必要なら手動掃除
```

各コマンドの全オプションは [03-commands.md](./03-commands.md)。
