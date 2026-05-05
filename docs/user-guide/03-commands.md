# 03. コマンドリファレンス

> この章で解決すること: 各 `autokit` コマンドの引数・オプション・出力・終了コードを一箇所で引ける。

## グローバルオプション

```
-V, --version          バージョン表示（autokit version と等価）
-y, --yes              非対話デフォルト回答（一部コマンドで参照）
-v, --verbose          デバッグログ
--config <path>        config.yaml 上書き（CLI 登録のみ。実体は v0.1.0 で未参照）
--force-unlock         lock seizure を要求（CLI 登録のみ。実体は v0.1.0 で未参照）
```

`--config` と `--force-unlock` はオプション登録だけ存在する。実装が完了するまでユーザーが指定する必要は無い。

環境変数 `AUTOKIT_ASSUME_YES=1` でも `--yes` 相当が有効になる。

## 終了コード（共通）

| コード | 意味 | 出る代表シナリオ |
|--------|------|------------------|
| `0` | 正常終了 / 全タスク `merged` | `version`, `init`, `list`, `doctor`(PASS), `run`(全 merge) |
| `1` | 失敗 / 引数誤り / 該当なし | doctor FAIL, status no-running-task, retry でも failed 残る |
| `2` | コマンド構文エラー | range parse 失敗, positive integer 期待箇所に非数 |
| `75` | resumable（後で `autokit resume`/`run` 再実行） | `run`/`resume`/`retry` で `paused` / `cleaning` 残存 |

`75` は POSIX の `EX_TEMPFAIL`。CI で「リトライ可能」を判別する用途。

---

## `autokit version`

バージョン表示。

```bash
autokit version
# => autokit 0.1.0
```

`autokit --version` / `autokit -V` と同じ結果。

---

## `autokit init`

リポジトリに `.autokit/` および `.agents/` を生成、`.claude/{agents,skills}` / `.codex/{agents,skills}` symlink を張り、`AGENTS.md` / `CLAUDE.md` にマーカーブロックを追記する。

```bash
autokit init [--dry-run] [--force]
```

| オプション | 用途 |
|------------|------|
| `--dry-run` | 書き込まず計画だけ標準出力。終了コード 0 |
| `--force` | `.autokit/.backup/` 残留があっても強行 |

初回挙動:

1. doctor 同等の前提チェック（git repo / gh auth / env unset）
2. 既存 symlink・マーカー対象に対する safety 検査（`symlink_invalid` で abort）
3. `.autokit/` / `.agents/` 配下を `0o600`（ファイル）/ `0o700`（ディレクトリ）で生成
4. backup ディレクトリを作成し、マーカー追記前のファイルを退避
5. 失敗時は rollback。rollback 失敗時は `init_rollback_failed` 監査イベントを残し backup を保持

出力例:

```
init complete
change	.autokit/audit-hmac-key
change	.autokit/config.yaml
change	.autokit/tasks.yaml
change	.agents/agents/...
change	.claude/skills
...
skip	AGENTS.md
```

---

## `autokit doctor`

環境前提チェック。

```bash
autokit doctor
```

実行されるチェック（順序固定）:

| name | PASS 条件 |
|------|-----------|
| `git repo` | `git rev-parse --is-inside-work-tree` が成功 |
| `gh auth` | `gh auth status` が成功 |
| `env unset` | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` がすべて未定義 |
| `cwd .env` | `.env` / `.env.local` / `.env.development` / `.env.production` に上記 API key 行が無い |
| `config` | `.autokit/config.yaml` が存在し parse 可能（無ければ WARN） |
| `prompt contracts` | `.agents/prompts/` に `DEFAULT_CONFIG` 期待のファイルが揃っている（無ければ WARN） |

出力フォーマット: `<STATUS>\t<name>\t<message>`。`FAIL` が 1 つでもあれば exit 1。

---

## `autokit add`

GitHub Open issue を取得し `.autokit/tasks.yaml` に追加する。

```bash
autokit add <range> [--label <name>] [--force] [--dry-run] [-y]
```

| 引数 / オプション | 説明 |
|------------------|------|
| `<range>` | `10` / `10-13` / `10,15,20` / `all` |
| `--label <name>` | 必須 label。複数指定可。AND 条件 |
| `--force` | `merged` 済み issue の再投入を許可（`-retry-N` suffix で branch / worktree を分離） |
| `--dry-run` | tasks.yaml に書かず件数表示のみ |
| `-y, --yes` | 確認プロンプト省略（`AUTOKIT_ASSUME_YES=1` でも可） |

スキップ条件:

- issue が CLOSED → `skip #N: issue is closed`
- 必須 label 不足 → `skip #N: missing required label`
- 既に active な task が存在 → `skip #N: task already active`（exit 1）
- 既に merged で `--force` なし → `skip #N: merged task requires --force`

`gh issue view` / `gh issue list` を内部で叩く。`GH_TOKEN` か `gh` 認証が要る。

---

## `autokit list`

tasks.yaml を表示。

```bash
autokit list [--json]
```

デフォルトは表形式:

```
ISSUE  STATE       RUNTIME_PHASE  PR    BRANCH                    UPDATED
10     queued      -              -     -                         2026-05-05T...
12     reviewing   review         #42   issue-12-fix-typo         2026-05-05T...
```

`--json` を付けると issue / state / runtime_phase / pr / branch / worktree_path / review_round / ci_fix_round / failure / updated_at の配列を整形 JSON で返す。

---

## `autokit status`

現在 active な task 1 件を JSON で出力する。

```bash
autokit status
```

active = `queued` / `merged` / `failed` 以外の最初の 1 件。該当なしなら `no running task` を stderr に出して exit 1。

JSON は `{ issue, state, runtime_phase, review_round, ci_fix_round, resolved_model, failure }`。

---

## `autokit run`

ワークフロー本体を実行。

```bash
autokit run
```

挙動:

1. `.autokit/tasks.yaml` の最初の active task を 1 件選ぶ
2. その state に対応するフェーズワークフローを呼び、結果を atomic write
3. terminal（`merged`/`failed`）または waiting（`paused`）に達するまで最大 100 ステップ繰り返す
4. 最終状態に応じて `getWorkflowExitCode` を返す（0 / 1 / 75）

途中で runner が `need_input` を返すと `paused` に入る。グローバル `-y` を渡すと auto-answer 経路（`createNeedInputAutoAnswer`）に切り替わるが、active runner question payload が無いケースでは `-y` でも進めない（warn ログを出して paused のまま終わる）。

failure 詳細は [06-recovery.md](./06-recovery.md)。

---

## `autokit resume`

paused からの復帰判定。

```bash
autokit resume [issue]
```

| 引数 | 説明 |
|------|------|
| `[issue]` | 省略可。指定すると該当 issue が `paused` であることを検証する |

挙動:

- 引数 issue を指定し、見つからなければ exit 1
- 指定 issue が `paused` でなければ exit 1
- `paused` task のうち `failure.code === "retry_cleanup_failed"` のものは `autokit retry` を案内して exit 75
- それ以外は `getWorkflowExitCode(tasks)` を返す（実状態に応じ 0 / 1 / 75）

実行で「先に進める」のは `autokit run` であり、`resume` は **状態確認 + 案内** が主目的。原因解消後に `autokit run` を再度実行する。

---

## `autokit retry`

failed タスクの cleanup 後再投入。

```bash
autokit retry [range] [--recover-corruption <issue>]
```

| 引数 / オプション | 説明 |
|------------------|------|
| `[range]` | `add` と同じ range 文法。省略すると `failed` 全件と `failure.code = retry_cleanup_failed` 全件が対象 |
| `--recover-corruption <issue>` | tasks.yaml の corruption 復旧専用モード。backup から復元して指定 issue を確認する |

各対象に対し:

- PR が存在すれば `gh pr close`
- worktree があれば `git worktree remove --force`
- branch があれば `git branch -D`
- task entry を queued に書き戻す

最終終了コード: 全件 `queued` 復帰なら 0、`failed` 残存なら 1、`paused`/`cleaning` 残存なら 75。

---

## `autokit cleanup`

merged 済みなのに後始末が完了していない task を、安全条件を確認した上で完了状態に持っていく。

```bash
autokit cleanup --force-detach <issue> [--dry-run]
```

| オプション | 説明 |
|------------|------|
| `--force-detach <issue>` | **必須**。1 件指定 |
| `--dry-run` | precondition 評価のみ。書き換えなし |

force-detach 候補:

- `state === "cleaning"`
- `state === "paused"` かつ `failure.code` が `branch_delete_failed` or `worktree_remove_failed`

precondition 検査:

1. `gh pr view <N>` を呼ぶ
2. `state === "MERGED"` && `merged === true` && `headRefOid === task.pr.head_sha`

precondition 失敗時は task を `paused` (`merge_sha_mismatch`) に落として exit 1。
precondition OK のあと、`--dry-run` でなければインタラクティブ確認 (`force-detach cleanup?`) を取り、確認 OK で task を完全に `merged` 化（`cleaning_progress.*` を全て `done`）。

---

## 関連

- 復旧フローの全体像: [06-recovery.md](./06-recovery.md)
- フェーズ内訳: [05-workflow.md](./05-workflow.md)
- `failure.code` の正典定義: [`docs/SPEC.md`](../SPEC.md) §4.2.1.1
