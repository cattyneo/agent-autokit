# 03. コマンドリファレンス

> この章で解決すること: 各 `autokit` コマンドの引数・オプション・出力・終了コードを一箇所で引ける。

## グローバルオプション

```
-V, --version          バージョン表示（autokit version と等価）
-y, --yes              非対話デフォルト回答（一部コマンドで参照）
-v, --verbose          デバッグログ
--config <path>        config.yaml 上書き（CLI 登録のみ。実体は未参照）
--force-unlock         lock seizure を要求（CLI 登録のみ。実体は未参照）
```

`--config` と `--force-unlock` はオプション登録だけ存在する。lock busy からの復旧は `--force-unlock` ではなく、holder / PID を確認してからの手動復旧または recovery command で扱う。

環境変数 `AUTOKIT_ASSUME_YES=1` でも `--yes` 相当が有効になる。

## 終了コード（共通）

| コード | 意味 | 出る代表シナリオ |
|--------|------|------------------|
| `0` | 正常終了 / 全タスク `merged` | `version`, `init`, `list`, `doctor`(PASS), `run`(全 merge) |
| `1` | 失敗 / 引数誤り / 該当なし | doctor FAIL, status no-running-task, retry でも failed 残る |
| `2` | コマンド構文エラー | range parse 失敗, positive integer 期待箇所に非数 |
| `75` | resumable（後で `autokit resume`/`run` 再実行） | `run`/`resume`/`retry` で `paused` / `cleaning` 残存、または lock busy |

`75` は POSIX の `EX_TEMPFAIL`。CI で「リトライ可能」を判別する用途。

---

## `autokit version`

バージョン表示。

```bash
autokit version
# => autokit <version>
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

## `autokit preset`

bundled preset と repository-local preset を扱う。

```bash
autokit preset list
autokit preset show <name>
autokit preset apply <name> [--allow-protected-replace]
```

| サブコマンド | 用途 |
|-------------|------|
| `list` | `default` / `laravel-filament` / `next-shadcn` / `docs-create` と local preset を一覧表示 |
| `show <name>` | path / content blacklist と public redactor を通した安全な内容表示 |
| `apply <name>` | `.agents/` と `.autokit/config.yaml` に反映。apply 後 doctor 相当検証を行う |

探索順は `.autokit/presets/<name>` の local preset が優先、その後 bundled preset。`apply` は state-changing command なので `.autokit/.lock/` を取得し、lock busy なら exit `75` で `.agents` / `tasks.yaml` を変更しない。

安全制約:

- 絶対 path / `..` / symlink / NUL byte / `.agents` 外 realpath は `preset_path_traversal` で fail-closed。
- `.env*` / `.codex/**` / `.claude/credentials*` / private key / token-like content は `preset_blacklist_hit` で fail-closed。
- `logging.redact_patterns` / `init.backup_blacklist` / `permissions.claude.allowed_tools` は protected array。通常 apply では防御を弱められない。
- `--allow-protected-replace` は protected replacement を明示許可するが、capability table 由来 hard cap を超える権限昇格は引き続き拒否される。

---

## `autokit config show`

実効 config と capability matrix を表示する。

```bash
autokit config show
autokit config show --matrix
```

`--matrix` は 7 agent phase × 2 provider の許可組、permission profile、effort 解決対象を確認する用途。`ci_wait` / `merge` は core-only なので matrix には出ない。

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

JSON は `{ issue, state, runtime_phase, review_round, ci_fix_round, resolved_model, failure }` と runtime 由来の要約を返す。`resolved_effort` / `phase_override` / `provider_sessions` の詳細は `.autokit/tasks.yaml` の task entry で確認する。

---

## `autokit run`

ワークフロー本体を実行。

```bash
autokit run [--phase <phase> (--provider <provider>|--effort <effort>)]
```

挙動:

1. `.autokit/tasks.yaml` の最初の active task を 1 件選ぶ
2. その state に対応するフェーズワークフローを呼び、結果を atomic write
3. terminal（`merged`/`failed`）または waiting（`paused`）に達するまで最大 100 ステップ繰り返す
4. 最終状態に応じて `getWorkflowExitCode` を返す（0 / 1 / 75）

途中で runner が `need_input` を返すと `paused` に入る。グローバル `-y` を渡すと auto-answer 経路（`createNeedInputAutoAnswer`）に切り替わるが、active runner question payload が無いケースでは `-y` でも進めない（warn ログを出して paused のまま終わる）。

### 1 run override

`--phase` と `--provider` / `--effort` で 1 回だけ provider / effort を上書きできる。

```bash
autokit run --phase plan --provider codex
autokit run --phase implement --effort high
autokit run --phase review --provider claude --effort low
```

制約:

- `--provider` / `--effort` は `--phase` 必須。違反は exit `2`。
- `--phase` は `plan` / `plan_verify` / `plan_fix` / `implement` / `review` / `supervise` / `fix` のみ。`ci_wait` / `merge` は指定不可。
- `provider` は `claude` / `codex`、`effort` は `auto` / `low` / `medium` / `high` のみ。
- permission profile は CLI から変更できない。phase の capability table から固定導出される。

failure 詳細は [06-recovery.md](./06-recovery.md)。

---

## `autokit serve`

local HTTP API / SSE server を起動する。

```bash
autokit serve [--host 127.0.0.1] [--port 0]
```

起動時に `serve listening` と `token file` を出力する。token は毎起動で再生成され、`Authorization: Bearer <token>` ヘッダのみ受理する。

主な endpoint:

| endpoint | 用途 |
|----------|------|
| `GET /api/tasks` / `GET /api/tasks/:issue` | bearer + Host gate 付き状態参照 |
| `GET /api/tasks/:issue/logs` / `diff` | sanitize 済み logs / diff |
| `POST /api/run` / `resume` / `retry` / `cleanup` | state-changing 操作。`application/json` 必須 |
| `GET /api/events` | SSE。`task_state` / `phase_started` / `phase_finished` / `audit` / `runner_stdout`(debug) / `heartbeat` / `error` |

Host allowlist は `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`。Origin は同一オリジンまたは欠落のみ許可し、`Origin: null` と allowlist 外 Origin は 403。

---

## `autokit logs` / `autokit diff`

issue 単位で sanitize 済み evidence を表示する。

```bash
autokit logs --issue <issue>
autokit diff --issue <issue>
```

`logs` は rotated log を結合して redactor を通す。`diff` は path blacklist hunk を除去し、非ブラックリスト path の token-like content も redact する。

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
- `failure.code` の正典定義: [`docs/SPEC.md`](../../docs/SPEC.md) §4.2.1.1
