# 04. 設定とディレクトリ構造

> この章で解決すること: `.autokit/` `.agents/` の中身、`config.yaml` フィールド、参照される env 変数、HMAC 鍵の扱いを把握する。

正典: [`docs/SPEC.md`](../SPEC.md) §3.2 / §4.1 / §4.2。本章は実装値ベースの実用要約。

## ディレクトリ構造（init 後）

```
target-repo/
├─ .autokit/
│  ├─ config.yaml              ランタイム設定（init 時 minimal 内容）
│  ├─ tasks.yaml               タスクキューと state（atomic write）
│  ├─ audit-hmac-key           監査ログ署名鍵（mode 0600、再生成厳禁）
│  ├─ init-audit.jsonl         init rollback 等の監査ログ
│  ├─ logs/                    各 run のログ（run 時生成）
│  ├─ reviews/                 レビュー成果物 (issue-{N}-review-{round}.md)
│  └─ .backup/<timestamp>/     init 時バックアップ。正常終了で削除
├─ .agents/
│  ├─ agents/
│  ├─ skills/
│  └─ prompts/                 phase ごとの prompt-contract Markdown
├─ .claude/
│  ├─ agents -> ../.agents/agents
│  └─ skills -> ../.agents/skills
├─ .codex/
│  ├─ agents -> ../.agents/agents
│  └─ skills -> ../.agents/skills
├─ AGENTS.md                   末尾に <!-- autokit:init:start --> ブロック
└─ CLAUDE.md                   同上
```

権限: ディレクトリは `0o700`、ファイルは `0o600`。これより緩い permission は `init` が拒否することがある。

## `config.yaml`

`init` が書く最小内容:

```yaml
version: 1
parallel: 1
auto_merge: true
```

省略フィールドは全て `DEFAULT_CONFIG`（`packages/core/src/config.ts`）でデフォルト充填される。主なデフォルト値:

| キー | デフォルト | 意味 |
|------|-----------|------|
| `version` | `1` | スキーマ版。`1` 固定 |
| `parallel` | `1` | 並列数。v0.1.0 では実質 1 のみ |
| `base_branch` | `""` | 空なら `main` を使う |
| `branch_prefix` | `"autokit/"` | 自動 branch 名 prefix |
| `auto_merge` | `true` | GitHub auto-merge 予約を使う |
| `review.max_rounds` | `3` | レビューループ最大ラウンド |
| `review.warn_threshold` | `2` | このラウンド以降は警告ログ |
| `plan.max_rounds` | `4` | plan ↔ plan_verify ↔ plan_fix の最大反復 |
| `ci.poll_interval_ms` | `10000` | CI チェックポーリング間隔 |
| `ci.timeout_ms` | `1800000` | 30 分 |
| `ci.timeout_action` | `"paused"` | timeout で `paused` に落とす |
| `ci.fix_max_rounds` | `3` | CI 失敗 → fix の最大ラウンド |
| `merge.poll_interval_ms` | `5000` | auto-merge 完了ポーリング |
| `merge.timeout_ms` | `1800000` | 30 分 |
| `merge.branch_delete_grace_ms` | `5000` | merge 確定→branch 削除の猶予 |
| `merge.worktree_remove_retry_max` | `3` | worktree 削除リトライ上限 |
| `label_filter` | `[]` | 追加で必須にする label。空なら `add --label` のみ参照 |
| `runtime.max_untrusted_input_kb` | `256` | runner 入力サイズ上限 |

### `phases.<phase>` フィールド

各フェーズで使う provider / model / prompt_contract を上書きできる。デフォルトは:

| phase | provider | model | prompt_contract |
|-------|----------|-------|-----------------|
| `plan` | `claude` | `auto` | `plan` |
| `plan_verify` | `codex` | `auto` | `plan-verify` |
| `plan_fix` | `claude` | `auto` | `plan-fix` |
| `implement` | `codex` | `auto` | `implement` |
| `review` | `claude` | `auto` | `review` |
| `supervise` | `claude` | `auto` | `supervise` |
| `fix` | `codex` | `auto` | `fix` |

`model: auto` は CLI 既定モデル。明示指定する場合の例:

```yaml
phases:
  implement:
    provider: codex
    model: gpt-5-codex
```

### `permissions`

```yaml
permissions:
  claude:
    auto_mode: optional        # off | required | optional
    workspace_scope: worktree  # worktree | repo
    allowed_tools: [Read, Grep, Glob]
    home_isolation: shared     # shared | isolated
  codex:
    sandbox_mode: workspace-write  # workspace-write | readonly
    approval_policy: on-request    # on-request | never | always
    allow_network: false
    home_isolation: shared
```

制約: `codex.allow_network: true` のときは `codex.home_isolation: isolated` 必須（schema 検証で reject）。

### `runner_timeout`

phase ごとのタイムアウト ms。未指定は `default_ms` (`600000` = 10 分) にフォールバック。

| キー | デフォルト | 備考 |
|------|-----------|------|
| `plan_ms` | `600000` | 10 分 |
| `implement_ms` | `1800000` | 30 分 |
| `review_ms` | `600000` | 10 分 |
| `default_ms` | `600000` | フォールバック |
| `default_idle_ms` | `300000` | runner 沈黙検知 |
| `plan_verify_ms` / `plan_fix_ms` / `supervise_ms` / `fix_ms` | unset | unset なら `default_ms` |

### `logging`

```yaml
logging:
  level: info                # debug | info | warn | error
  retention_days: 30
  max_file_size_mb: 100
  max_total_size_mb: 1024
  redact_patterns:
    - "ghp_[A-Za-z0-9]{20,}"
    - "sk-[A-Za-z0-9]{20,}"
```

`redact_patterns` は logs 出力時のマスク用。github token / API key 形を初期登録。

### `init`

```yaml
init:
  backup_dir: .autokit/.backup
  backup_mode: "0700"
  backup_blacklist:
    - .claude/credentials*
    - .claude/state
    - .claude/sessions
    - .codex/auth*
    - .codex/credentials*
    - .autokit/audit-hmac-key
```

backup blacklist にマッチするファイルが既に存在する状態で `init` を実行するとエラーで abort する（認証情報の誤バックアップ防止）。

## `tasks.yaml`

スキーマは `version` / `generated_at` / `tasks[]`。`tasks[N]` の主な可視フィールド:

```yaml
- issue: 12
  title: "Fix typo in README"
  slug: "fix-typo-in-readme"
  state: reviewing                       # 状態（後述）
  runtime_phase: review                  # 現在進行中の phase
  branch: autokit/issue-12-fix-typo
  worktree_path: .autokit/worktrees/issue-12-fix-typo
  pr:
    number: 42
    head_sha: "abc123..."
  review_round: 2
  ci_fix_round: 0
  failure: null
  timestamps: {...}
  cleaning_progress: {...}
  runtime: { resolved_model: "..." }
```

state（取りうる値）:

| state | 意味 |
|-------|------|
| `queued` | これから処理 |
| `planning` / `planned` / `implementing` / `reviewing` / `fixing` / `ci_waiting` / `merging` / `cleaning` | 進行中 |
| `paused` | 人手必要（`failure.code` で詳細） |
| `merged` | 完了 |
| `failed` | 終端失敗 |

`failure.code` 一覧の正典は [`docs/SPEC.md`](../SPEC.md) §4.2.1.1。

書き込みは常に temp file → fsync → rename の atomic 手順（`writeTasksFileAtomic`）。

## 環境変数

### autokit が **読む** 変数

| 変数 | 用途 |
|------|------|
| `AUTOKIT_ASSUME_YES` | `1` で `--yes` 相当 |
| `GH_TOKEN` / `GITHUB_TOKEN` | `gh` 認証（`buildGhEnv` 経由で runner にも渡る） |
| `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` | runner 認証ディレクトリ解決 |
| `PATH` / `HOME` / `USER` / `LOGNAME` / `LANG` / `TERM` / `TZ` / `LC_*` | child process に最小限渡す |
| `CODEX_HOME` | codex CLI の認証ディレクトリ上書き |

### autokit が **絶対に export していてはいけない** 変数

```bash
unset ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY
```

これらは `doctor` および `run` 開始時に検出され、見つかると即エラー終了する（subscription / API key の二重認証で課金経路を取られないため）。

## `audit-hmac-key`

- `init` 時に 32 bytes random を hex 出力したファイル（mode 0600）
- runner に渡る issue 本文を sanitize した HMAC-SHA256 ハッシュを監査ログに残すための鍵
- **再生成すると過去の監査ログとの整合が取れなくなる**。`.autokit/.backup/` 経由でしか復旧できない
- `backup_blacklist` に登録されているため `init --force` でも誤バックアップされない

## `init-audit.jsonl`

`init_rollback` / `init_rollback_failed` イベントを 1 行 1 JSON で記録。`init` が成功した時点で削除される。残っている = 直近の `init` が rollback / rollback-failure を経験している。

## 関連

- フェーズ単位の処理: [05-workflow.md](./05-workflow.md)
- state 別の復旧: [06-recovery.md](./06-recovery.md)
- スキーマの正典: [`packages/core/src/config.ts`](../../packages/core/src/config.ts)
