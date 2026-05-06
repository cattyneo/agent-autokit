# agent-autokit Phase 1-4 実装計画

作成日: 2026-05-05
更新日: 2026-05-06 (review-fix 反映)

## 目的

`agent-autokit` を、GitHub Issue 起点で plan / implement / review / fix / CI / merge まで進めるローカル実行基盤として実用化する。

重点:

- 任意フェーズで Claude / Codex を切り替える
- フェーズごとに model / effort / prompt / skill を切り替える
- review → supervise → fix と ci → fix の修正ループを安定化する
- CLI を維持しつつ、進捗・ログ・差分を確認しやすくする
- preset で project ごとの prompt / skill / agents を安全に切り替える

## 基本方針

- `core` は state / git / gh / PR / merge / cleanup を単独所有する。runner は git/gh 直叩き禁止
- `runner` は Claude / Codex 呼び出し adapter に徹する
- `prompt_contract` の構造化出力 schema は不変。Phase 4 の prompt 改善は自由記述部のみ
- `.autokit/config.yaml` を設定の SoT にする
- API key env unset、subscription auth、sanitize / redact 方針は維持
- `tasks.yaml` checkpoint / resume / retry 設計を壊さない
- 新 `failure.code` / 新 audit kind を追加する PR は SPEC §4.2.1.1 / §10.2.2.2 を同 PR で更新 (`scripts/check-trace.sh` 1:1 trace gate)
- 対象 phase は `plan / plan_verify / plan_fix / implement / review / supervise / fix` の 7 種。`ci_wait` / `merge` は core-only で provider / effort / skill 設定対象外

---

## Phase 1: CLI / Core / Runner 安定化

### 1. Capability table を SoT 化 (`packages/core/src/capability.ts` 新設)

現在 phase × provider × permission の判定が runner / workflows / doctor / `init.ts` の `DEFAULT_CONFIG_YAML` に分散。これを core 単独所有に統合。

```ts
// packages/core/src/capability.ts (新設)
type Phase = "plan"|"plan_verify"|"plan_fix"|"implement"|"review"|"supervise"|"fix";
type Provider = "claude"|"codex";
type Effort = "auto"|"low"|"medium"|"high";

interface CapabilityRow {
  phase: Phase;
  provider: Provider;
  permission_profile: "readonly_repo" | "readonly_worktree" | "write_worktree";
  // 抽象 (scope, write) → provider 別 keys は capability table から導出
  // claude: allowed_tools / denied_tools / pretooluse hook
  // codex:  sandbox (read-only | workspace-write) / network
  derive_claude_perm(): { allowed_tools: string[]; denied_tools: string[]; hook: "readonly_path_guard" | "write_path_guard" };
  derive_codex_perm(): { sandbox: "read-only" | "workspace-write"; network: "off" };
}
```

責務分担:

- runner / workflows / doctor / init は capability table を `import` して assert / 構築 / 検証に徹する
- runner 内の phase 固定リスト (`claudeRunnerPhases` 等) は廃止
- `packages/cli/src/init.ts` の独立リテラル `DEFAULT_CONFIG_YAML` は core `DEFAULT_CONFIG` を YAML serialize に置換 (もしくは `assets/.autokit/config.yaml.template` 外出し + CI gate)
- 既存 `permissions.claude.allowed_tools` 設定は deprecate path を明記。当面は capability 由来の許可と union (mode-keyed) を取り、warn ログで利用者に migrate 通知

permission profile 表 (対象 7 phase):

| phase | scope | write | claude profile | codex sandbox |
|---|---|---:|---|---|
| plan | repo | no | readonly_repo | read-only |
| plan_verify | repo | no | readonly_repo | read-only |
| plan_fix | repo | no | readonly_repo | read-only |
| implement | worktree | yes | write_worktree | workspace-write |
| review | worktree | no | readonly_worktree | read-only |
| supervise | worktree | no | readonly_worktree | read-only |
| fix | worktree | yes | write_worktree | workspace-write |

注: `ci_wait` / `merge` は core-only。capability table / permission profile / dashboard 表示の provider 列対象外。

### 2. Provider 自由切替 (capability 軸へ統合)

- `config.phases.<phase>.provider` を実行時に尊重
- runner の phase 固定制約は capability table 由来へ置換
- 不正な provider / permission 組み合わせは `doctor` と `run` 開始時に fail-closed
- 安全境界は provider ではなく phase 側で固定 (CLI override で緩めない、§6 参照)

### 3. Effort policy

#### 3.1 EffortLevel

```ts
type EffortLevel = "auto" | "low" | "medium" | "high";
```

縮約理由: `minimal` / `xhigh` / `max` は Claude / Codex のいずれも native 値を持たず、autokit profile としても medium / high と挙動分離が困難。dead option 化を避けるため Phase 1 は 4 値に絞る。将来 native サポート時に追加し SPEC で明示する。

#### 3.2 Effort × provider × profile マッピング (SoT は `packages/core/src/effort-resolver.ts` 新設)

| effort | provider | model | max_turns | timeout_ms | native effort | prompt policy |
|---|---|---|---:|---:|---|---|
| auto | claude | (provider既定) | 16 | 1800000 | n/a | 既定 |
| auto | codex | (provider既定) | n/a | 1800000 | medium | 既定 |
| low | claude | sonnet | 8 | 1200000 | n/a | 簡潔指示 |
| low | codex | gpt-5.4-mini | n/a | 1200000 | low | 簡潔指示 |
| medium | claude | sonnet | 16 | 1800000 | n/a | 既定 |
| medium | codex | gpt-5.4 | n/a | 1800000 | medium | 既定 |
| high | claude | opus | 32 | 3600000 | n/a | 詳細手順含 |
| high | codex | gpt-5.4 | n/a | 3600000 | high | 詳細手順含 |

- `auto` 解決時点: core `effort-resolver.ts` が `phase 開始直前` に解決。runner は受け取った値を CLI 引数化のみ
- Claude は native effort flag を前提にしない (autokit profile)
- Codex は `--reasoning-effort` を runner 起動時に明示

**timeout 合成規則** (effort 由来 vs `runner_timeout.<phase>_ms` の優先順位):

- `runner_timeout.<phase>_ms` がユーザー明示 (config に値あり) → そちら優先。effort 由来 timeout は無視
- `runner_timeout.<phase>_ms` 未設定 (zod default 適用) → effort 由来値を採用
- `runner_timeout.*_idle_ms` (idle timeout) は effort 軸対象外。既存 config 値を全 effort 共通で適用
- `effort-resolver.ts` の出力 `resolved_effort.timeout_ms` は **最終解決値** (上記優先順位適用後)。runner には解決値のみが渡る
- 判定基準: zod schema で「ユーザー明示」と「default 適用」を区別する。`runner_timeout` の各 `<phase>_ms` は `optional()` を維持し、`undefined` を「ユーザー未設定」、値ありを「ユーザー明示」と判定 (現行 `plan_ms` 等の `default(...)` 呼出は明示判定不可になるため `optional()` + 解決時に default 値適用へ migrate)

#### 3.3 Unsupported policy と downgrade ladder

```yaml
effort:
  default: medium
  unsupported_policy: fail  # fail | downgrade
```

- `fail`: 解決時点で `failure.code=effort_unsupported` で停止
- `downgrade`: ladder `high → medium → low → auto` の順に 1 段階だけ落とす。downgrade 発生時は `failure.code=effort_downgraded` ではなく **audit kind: `effort_downgrade`** を log に残し、`runtime.resolved_effort` に解決後値を保存。silent 落としは禁止
- ladder 最終フォールバック: `auto` も不可なら `fail` 同等で停止

#### 3.4 段階導入オプション (実装着手判断用)

実装コスト懸念がある場合、Phase 1 を以下 2 段階に分割可:

- 1a: Codex のみ effort 反映、Claude は受理して no-op (resolved_effort に値だけ記録)
- 1b: Claude も autokit profile 変換を実装

### 4. Config / Runtime / Tasks 拡張

`packages/core/src/config.ts` 拡張:

- `PhaseConfig.effort?: EffortLevel`
- `effort.default: EffortLevel`
- `effort.unsupported_policy: "fail"|"downgrade"`

`TaskEntry.runtime` 拡張 (zod schema、旧 yaml 互換 default null):

```ts
runtime: {
  // 既存フィールド維持
  resolved_effort?: { phase: Phase; provider: Provider; effort: EffortLevel; downgraded_from?: EffortLevel } | null;
  phase_self_correct_done?: boolean | null;  // §5 self-correction
  phase_override?: { phase: Phase; provider?: Provider; effort?: EffortLevel; expires_at_run_id: string } | null;  // §6 override
}

provider_sessions: {
  // 既存 {claude_session_id?} | {codex_session_id?} を統合
  [phase: Phase]: { claude_session_id?: string; codex_session_id?: string; last_provider?: Provider } | null;
}
```

維持する制約:

- `prompt_contract` は phase と 1:1
- read-only phase で書き込み不可 (CLI override でも緩めない)
- network 設定は既存方針を維持
- provider / model / effort が不明な場合は `doctor` で検出

### 5. Runner 更新

#### 5.1 Claude runner 全面書換

現状: `claudeRunnerPhases=["plan","plan_fix","review","supervise"]` ホワイトリスト + `permissions.mode!=="readonly"` 全 phase 拒否 + `DENIED_TOOLS=["Bash","Edit","Write","WebFetch","WebSearch"]` 常時拒否 + readonly path guard hook で fail-closed。これを capability table 駆動へ書換。

- `claudeRunnerPhases` 廃止 → capability table の `derive_claude_perm()` 由来
- `assertClaudeInput` の mode/scope 分岐を `(phase, permission_profile)` matrix で書換
- `DENIED_TOOLS` 動的化 (write profile では `Edit/Write/Bash` を allowed_tools に)
- write profile 用 PreToolUse hook 新設: `write_path_guard` が Edit/Write/Bash の path / cmd を実 worktree 配下に閉じ込め、`.env*` `.codex/**` `.claude/credentials*` `id_rsa*` `*.pem` `*.key` への書込を fail-closed
- Bash 許可コマンド allowlist (`build/test/lint/format` 系)。`git` `gh` は core 単独所有のため runner 直叩き禁止 (allowlist から除外)
- effort は autokit profile (§3.2) として model / max_turns / timeout / prompt policy に変換

#### 5.2 Codex runner

- 全 phase を受けられるよう `validatePromptContractPayload` (受理側意味論) を共通化
- ただし **`*JsonSchema` (provider に渡す strict schema) は provider-specific のまま**: `codexPromptContractJsonSchema` の `data/question required + null union + plan-verify result/findings anyOf` を維持し、`data` 中身だけ phase 全種に拡張する
- `normalizeCodexFinalPayload` で null を剥がす既存処理を維持
- read-only profile は sandbox `read-only`、write profile は `workspace-write`
- effort は native `--reasoning-effort` で渡す
- session resume / JSONL parse は既存設計を維持

### 6. CLI override の安全制約

`autokit run --phase <phase> --provider <claude|codex> --effort <level>` は以下の制約下のみ受理:

- **permission profile を変更しない**。capability table の `(phase, provider)` 許可組のみ受理。permission 軸は table から導出し CLI で上書き不可
- override 時も state-machine 経由 (新 `TransitionEvent: phase_override_started` / `phase_override_ended` を追加)、runner 直叩き不可
- override 永続性: **1 run 限り** (`runtime.phase_override.expires_at_run_id` で固定)。次回 run には引き継がない
- `provider_sessions.<phase>` は §4 拡張で `{claude_session_id?, codex_session_id?, last_provider?}` 化済み。override 後の resume も session 復元可能
- doctor + run 開始時 fail-closed: 「override 後 effective permission が phase 既定より緩い」「(phase, provider) が capability table 不許可」をいずれも検出

### 7. Review / Fix ループ安定化

対象ループ:

```text
review → supervise → fix → review
ci_wait → fix → ci_wait
```

#### 7.1 停止条件 (観測可能 AC)

停止時に `tasks.yaml.failure.code` が以下のいずれか:

- `review_max` — `review.max_rounds` 到達
- `ci_failure_max` — `ci.fix_max_rounds` 到達
- `prompt_contract_violation` — 構造化出力契約違反 (self-correction retry も失敗)
- `phase_attempt_exceeded` — phase ごとの試行上限到達

audit log に固定 sequence で kind が記録される (例: `phase_started → review_finding_seen → fix_started → fix_finished → review_started`)。E2E は audit kind 列で assert。

#### 7.2 Self-correction retry

- `prompt_contract_violation` 検出時、**1 回限り** self-correction retry を許可
- 1 回判定: `runtime.phase_self_correct_done` フラグで管理 (§4 拡張済み)
- state-machine に新 `TransitionEvent: prompt_contract_self_correct` を追加。workflows 内 try/catch で隠蔽せず、必ず state-machine 経由
- self-correction の resume / exit code 75 (TEMPFAIL) 整合: retry 中も checkpoint を進め、途中中断しても `resume` で続行可能

#### 7.3 ci-fix loop と core 単独所有

- ci-fix の `gh pr checks` 等は core `gh.ts` argv builder 経由のみ
- E2E は既存 `fakeGh` パターン (e2e/runners/full-run.test.ts) を `gh pr checks` / `gh run view` に拡張
- `ci_wait` / `merge` が runner に届かない仕様 (CLAUDE.md) と矛盾しないよう、ci-fix loop は workflows + core のみで完結

#### 7.4 SPEC trace 同 PR 更新

新 audit kind 追加: `effort_downgrade` / `phase_self_correct` / `phase_override_started` / `phase_override_ended` / `preset_apply_started` / `preset_apply_finished`
新 failure.code 追加: `effort_unsupported` / `review_max` / `ci_failure_max` / `prompt_contract_violation` / `phase_attempt_exceeded` / `lock_host_mismatch` / `preset_path_traversal` / `preset_blacklist_hit`

これらを core に入れた PR で SPEC §4.2.1.1 / §10.2.2.2 を必ず同時更新。`scripts/check-trace.sh` の 1:1 trace gate を緑にする。

### 8. CLI 追加

```bash
autokit config show           # config 全体 + capability matrix を一画面で表示
autokit config validate       # doctor 相当 (lint/serialization のみ)
autokit logs --issue <n>      # tasks/<issue>/logs を sanitize 経由で表示 (§9.1)
autokit diff --issue <n>      # working tree diff を blacklist hunk 除去 (§9.2)
```

整理:

- `phase matrix` は `config show --matrix` に畳む (役割重複削減)
- `logs` / `diff` は `tail -f` / `git diff` で代替不能なペルソナ向け: rotated log の自動結合・sanitize 済み出力・blacklist hunk 除去
- 一時 override (§6) は `run --phase / --provider / --effort` のみ

### 9. ログ・差分の sanitize / redact

#### 9.1 logs 出力

- `autokit logs` 出力時に既存 `sanitizeLogString` で再 sanitize (二重 redact)
- rotated log を時系列結合してから sanitize

#### 9.2 diff 出力

- 出力前に以下を含む hunk を **hunk 単位で削除しプレースホルダ表示**: `.env*` / `.codex/**` / `.claude/credentials*` / `id_rsa*` / `*.pem` / `*.key`
- working tree に operator が置いた credentials の差分が出力に混入するのを防ぐ

### Phase 1 完了条件 (観測可能)

- default provider split で E2E が完走 (audit kind 列で assert)
- 任意 phase の provider を config で変更でき、capability table が `(phase, provider)` の許可組を fail-closed で検証
- effort を phase ごとに設定でき、`runtime.resolved_effort` に解決後値が保存される
- invalid provider / effort / permission を `doctor` が検出し exit code 非 0
- review-fix loop / CI-fix loop の停止理由が `failure.code ∈ {review_max, ci_failure_max, prompt_contract_violation, phase_attempt_exceeded}` のいずれかで記録される
- self-correction retry が 1 回だけ走る E2E (`runtime.phase_self_correct_done=true`)
- `run / resume / retry / cleanup` の後方互換 (旧 tasks.yaml の zod default 適用 + 既存 e2e 全緑)
- 新 failure.code / audit kind を含む PR で `scripts/check-trace.sh` が緑

---

## Phase 2: Local API server + Dashboard (issue 分割)

Phase 2 を以下 2 issue に分割。MVP は Phase 2A のみ必須。

- **Phase 2A**: `autokit serve` (HTTP/JSON only) + cross-process lock + auth
- **Phase 2B**: Dashboard UI (Next.js + shadcn/ui or 軽量代替)

### 1. `autokit serve` (Phase 2A)

CLI runtime を利用するローカル API server。`packages/serve/` を新設し、`bun build` 可能な軽量 server (`Bun.serve` または `Hono`) を採用。Next.js runtime を CLI bin に巻き込まず、assets-hygiene gate の `workspace:` / unresolved import 禁止に抵触させない。

#### 1.1 API

```text
GET  /api/tasks
GET  /api/tasks/:issue
GET  /api/tasks/:issue/plan
GET  /api/tasks/:issue/reviews
GET  /api/tasks/:issue/logs
GET  /api/tasks/:issue/diff
POST /api/run
POST /api/resume
POST /api/retry
POST /api/cleanup
GET  /api/events            # SSE
```

#### 1.2 Cross-process lock と排他制御

`tasks.yaml` の atomic write は単プロセス OS rename のみ前提。serve 常駐後の CLI 直叩き ↔ HTTP API ↔ 将来の Dashboard click の三者間排他を新設:

- `packages/core/src/process-lock.ts` 新設、`flock(2)` ベースの `.autokit/.lock` を新設
- CLI / serve 双方が同 API 経由 (`acquireRunLock(repo)`) でしか run/resume/retry/cleanup 実行不可
- lock 取得失敗時の mapping: HTTP `409 Conflict` ↔ CLI exit `75 (TEMPFAIL) + failure.code=lock_host_mismatch`
- lock holder 情報 (PID / host / acquired_at) を `.autokit/.lock` に記録し、stale 検出で自動回収
- `POST /api/run` 中に同 repo `autokit run` は exit 75 + 「serve がロック中」ガイダンスを表示

#### 1.3 認可 / CSRF / DNS rebinding 対策

mutating endpoint (`POST /api/{run,resume,retry,cleanup}`) と SSE は内部で core の git/gh push / 自動 merge / branch 削除を直接トリガーする。最低限以下を必須:

- **bind**: 既定 `127.0.0.1` または Unix domain socket。`0.0.0.0` 拒否 (config で明示 opt-in も拒否、warn でなく fail)
- **bearer token**: 起動時生成、ファイル `${XDG_STATE_HOME:-~/.local/state}/autokit/serve.token` に mode 0600 で保存。CLI / Dashboard は同ファイル読込で同一トークンを共有
- **Origin / Sec-Fetch-Site**: `same-origin` ホワイトリスト必須。不一致は 403
- **Host header**: `127.0.0.1:PORT` / `localhost:PORT` 以外を 403 で拒否 (DNS rebinding 対策)
- **Content-Type**: mutating endpoint は `application/json` 必須。`application/x-www-form-urlencoded` / `multipart/form-data` は拒否 (simple form CSRF 防止)
- **`/api/events` (SSE)**: bearer + Origin + Host 同様。同時接続数上限を設定
- **404 / 401 切り分け**: 未認可リクエストが 401 で拒否される E2E を実装

#### 1.4 Sanitize / redact 配信

- logs / events は logger 出力後の sanitize 済み event のみ配信。生 stdout 直結禁止
- diff は §9.2 の blacklist hunk 除去後を配信
- レスポンスヘッダ: `Content-Type: text/plain; charset=utf-8` + `X-Content-Type-Options: nosniff`

#### 1.5 実行制御

- `parallel: 1` を維持
- API 操作は内部 workflow を呼ぶ (CLI 経路と同一の core API 経由)
- active task がある場合は 409 で拒否
- process crash 後は既存 `resume` に寄せる (lock の stale 回収後に再取得可)

### 2. Dashboard UI (Phase 2B、別 issue)

採用根拠: Phase 2A の curl/jq では plan / review findings / git diff の構造化表示やリアルタイム log tail が辛い。MVP UI を Ink TUI 拡張で済ませる選択肢も併記する。

候補:

- 軽量案: Ink TUI 拡張 (`packages/tui` 拡張)。assets-hygiene gate と整合容易
- 本格案: Next.js + shadcn/ui を別パッケージ (`packages/dashboard/`) に。`bun build` 静的成果物として配信、API は Phase 2A に依存。assets-hygiene の `workspace:` / unresolved import 禁止に抵触しない構成を別 issue で詰める

表示項目 (本格案):

- task 一覧
- phase timeline (audit kind 列)
- provider / model / effort / resolved_effort
- review_round / ci_fix_round
- plan viewer / review findings viewer / git diff viewer
- log tail (SSE)
- run / resume / retry / cleanup ボタン (bearer token 付与)

### Phase 2 完了条件 (観測可能)

#### Phase 2A 完了条件 (MVP 必須)

- `autokit serve` が `127.0.0.1` bind で起動し、bearer token なしの mutating request を 401 で拒否
- 不正 Origin / Host / Content-Type を 403 で拒否する E2E
- `POST /api/run` 中に同 repo で `autokit run` を起動すると exit 75 + `failure.code=lock_host_mismatch`
- `tasks.yaml` の cross-process 並行書込が `flock(2)` で直列化される
- `GET /api/events` の SSE が p95 < 1s で push され、生 stdout が漏れない (sanitize 済み event のみ)
- `GET /api/tasks/:issue/diff` が credentials 含む hunk をプレースホルダ化

#### Phase 2B 完了条件 (UI、別 issue)

- Dashboard から状態確認・run/resume/retry/cleanup を実行できる
- plan / review / diff を画面で確認できる
- CLI 単体運用と Dashboard 運用が同じ state を共有 (Phase 2A の lock + API 経由)

---

## Phase 3: Prompt / Skill Pack (preset)

### 1. Preset 構造

```text
.autokit/presets/
  default/
    config.yaml
    prompts/
    skills/
    agents/

  laravel-filament/
    ...
  next-shadcn/
    ...
  docs-create/
    ...
```

### 2. Preset Commands (MVP は 3 verb)

```bash
autokit preset list        # 一覧
autokit preset show <name> # 内容表示
autokit preset apply <name>
```

Phase 3+ で追加検討 (dead alias 化リスク回避のため後置):

- `apply --dry-run` (= `diff` の代替で十分か検討)
- `export <name>` (受信者・ユースケース未確定のため Phase 3+)

各 verb 想定ユースケース:

- `list`: 利用可能な preset の確認
- `show`: 適用前の中身把握
- `apply`: project に反映 (backup + atomic + doctor)

### 3. Apply の安全制約 (`packages/core/src/assets-writer.ts` 新設)

`init` と `preset apply` を同 API + `init.backup_dir` / `init.backup_blacklist` 共有:

#### 3.1 Path traversal / blacklist 防御

- preset archive エントリ毎に絶対パス / `..` / symlink 禁止 (絶対パス・親ディレクトリ参照・symlink を含むエントリは fail-closed `failure.code=preset_path_traversal`)
- 出力先 realpath が `.agents/` 配下に閉じることを assert
- deny-list 必須 (apply / export 両方): `.env*` / `.codex/**` / `.claude/credentials*` / `id_rsa*` / `*.pem` / `*.key`。ヒット時 `failure.code=preset_blacklist_hit` で fail-closed

#### 3.2 Atomic apply

- staging directory に展開 → 整合検証 → atomic rename (`.agents/` 全体差し替え)
- 失敗時 staging 破棄。`.agents/` は apply 前と byte 単位一致 (SHA256 manifest で復元可能)
- doctor 失敗時の rollback or paused 状態への遷移を実装

#### 3.3 Backup 配置

- backup 先は `${XDG_STATE_HOME:-~/.local/state}/autokit/backup/<repo>/<timestamp>/` (mode 0700)
- repo tree 内 (例 `.agents/.backup/`) には作らない (`scripts/check-assets-hygiene.sh` の禁止 glob を素通りするのを防止)
- retention は `init.backup.retention_days` (既存 config) 適用

#### 3.4 Merge patch 規則

`config.yaml` merge:

- object: deep merge
- array: preset 値で完全置換 (label_filter / allowed_tools / redact_patterns はユーザー側上書き想定が強いため確実な置換)
- 明示 `null`: default 復帰
- `prompts/` / `skills/` / `agents/` のファイルは **ファイル単位置換 + backup**。部分 merge しない

### 4. 初期 Preset

| preset | 用途 |
|---|---|
| default | 汎用 Issue 処理 |
| laravel-filament | Laravel / Filament 実装・レビュー |
| next-shadcn | Next.js / shadcn/ui 実装・UI 改善 |
| docs-create | ドキュメント作成・整合性レビュー |

注: 各 preset の `prompt_contract` schema は不変。phase 別 prompt の自由記述部のみカスタマイズ可。

### Phase 3 完了条件 (観測可能)

- `preset list / show / apply` が動作し、apply 後に `doctor` が緑
- preset apply 前後で `.agents/**` の SHA256 manifest が backup から復元可能
- path traversal / blacklist hit が `failure.code=preset_path_traversal` / `preset_blacklist_hit` で fail-closed
- prompt / skill 変更による `prompt_contract_violation` を `runner-contract.test.ts` で全 phase 検出
- backup 配置が repo tree 外 (`scripts/check-assets-hygiene.sh` 緑)
- Laravel / Next.js / docs-create 用の初期 preset が apply 可能で、E2E (fixture repo) が緑

---

## Phase 4: skills / prompts / agents 品質向上

注: 本 Phase は autokit を *使う* オペレーター作業手順。同梱 asset の SoT は `packages/cli/assets/skills/autokit-{implement,question,review}` (CLAUDE.md 準拠)。

### 1. skills 品質向上

原則:

- ステップで意図された挙動や契約を変えない (prompt_contract structured-output 不変)
- スキルは指示が肥大化する時、同じ指示を複数ステップで使い回す場合に限って利用する。それ以外は prompt 内に直接書く

修正案:

- `autokit-implement`: 既存 `tdd-workflow` をコピー (commit hash で pin)、本ツールに合わせて調整
- `autokit-review`: 既存 `general-review` をコピー (commit hash で pin)、本ツールに合わせて調整

> コピー元バージョン: PR 内で commit hash を明記し、上流更新時の同期義務を CONTRIBUTING に記載

### 2. prompt 品質向上

**重要**: prompt-contract structured-output schema は不変。Phase 4 の改善は **自由記述部 (rationale / steps / constraints) のみ**。「基本形」セクションは参考であり、出力の `## Result / ## Evidence / ## Changes / ## Test results` は既存 prompt-contract の構造化出力フィールドと mapping 表で対応 (mapping 表は実装 PR で添付)。

設定ポイント (全て書く必要はない、必要なものだけ簡潔):

| 観点 | 書くこと |
|---|---|
| 今回のタスク | 「何をするステップか」を冒頭で短く |
| 参照元     | 優先順位を明示 |
| 実行手順    | 番号付き actions |
| 条件分岐    | runtime 状況ごとの判断 |
| 検証義務    | build / test / functional check の実施範囲 |
| 失敗時の扱い | 「未確認なら成功扱いしない」等 |
| 変数の活用   | `{report:plan.md}` 等 runtime 変数 |

> 参考 (付録): takt facets/instructions

### 3. agents 品質向上

設定ポイント (全て書く必要はない):

| 観点 | 書くこと |
|---|---|
| 役割     | 1 文で定義 |
| 責務範囲  | Do / Don't |
| 判断基準  | 行動原則 |
| 権限境界  | 編集可否 / 1 agent = 1 responsibility |
| Source of Truth | 一次情報 |
| AI癖の禁止 | 推測 / 不要互換 / 未使用コード / fallback乱用 |
| 出力形式は薄く | prompt 側 + 構造化出力で制御 |

> 参考 (付録): takt facets/personas

### Phase 4 完了条件 (観測可能)

- 全 prompt が `runner-contract.test.ts` の `validatePromptContractPayload` を全 phase 通過
- `autokit-implement` / `autokit-review` skill が `runner-visibility.test.ts` fixture で緑
- prompt 改善 PR が `prompt_contract` schema 不変 (構造化出力フィールド diff なし) を CI で検証

---

## 実装順序

機能単位で SPEC trace を同 PR 更新する。step 13 を「user-guide のみ」に縮小し、SPEC 更新は各機能の core 実装と同 PR に分散する。

1. `packages/core/src/capability.ts` 新設 + `effort-resolver.ts` 新設 + `config.ts` に effort / capability validation 追加
2. `TaskEntry.runtime` 拡張 (resolved_effort / phase_self_correct_done / phase_override / provider_sessions 統合) + zod default で旧 yaml 互換
3. `AgentRunInput` に effort / effective permission を追加
4. runner の phase 固定制約を capability 判定へ置換 (Claude allowed/denied 動的化、write hook 新設、Bash allowlist)
5. Codex runner の effort 反映 (`--reasoning-effort`) と payload schema 共通化 (validate のみ、JsonSchema は provider-specific 維持)
6. Claude runner の effort profile 変換 (model / max_turns / timeout / prompt policy)
7. state-machine に新 `TransitionEvent` (prompt_contract_self_correct / phase_override_started/ended) 追加 + 新 failure.code / audit kind を SPEC §4.2.1.1 / §10.2.2.2 同 PR 更新
8. `doctor` に provider / effort / prompt / permission 検証を追加 + CLI override の安全 fail-closed
9. review-fix / ci-fix loop の E2E テスト追加 (audit kind 列で assert、fakeGh 拡張)
10. logs / diff の sanitize / blacklist hunk 除去
11. `process-lock.ts` + `autokit serve` (HTTP/JSON only、bearer/Origin/Host) + 401/403/409 E2E
12. `assets-writer.ts` 新設 + preset 構造と `list/show/apply` (path traversal / blacklist / atomic / XDG backup)
13. 初期 preset 追加 (default / laravel-filament / next-shadcn / docs-create)
14. skills / prompts / agents を見直して改善 (Phase 4)
15. user-guide / dev-guide を更新 (SPEC は step 1, 7, 11, 12 で機能と同 PR 更新済み)
16. (別 issue) Dashboard UI (Phase 2B)

## 主なリスクと対策

| リスク | 対策 |
|---|---|
| provider 自由化で安全境界が曖昧 | capability table を core 単独所有 SoT 化、CLI override で permission を変更不可 |
| Claude write phase が過剰権限 | write profile のみ allowed_tools 拡張 + write_path_guard hook + Bash allowlist (git/gh 除外) |
| effort の意味が provider/model でズレる | native effort と autokit profile を `effort-resolver.ts` で分離、downgrade ladder と audit kind |
| schema 共通化で構造化出力が壊れる | validate は共通、provider strict schema は provider-specific 維持 (Codex anyOf / null 維持) |
| prompt カスタムで構造化出力が壊れる | prompt_contract test と self-correction retry 1 回 + state-machine 経由 |
| Dashboard と CLI の二重起動 | `flock(2)` based `.autokit/.lock` + HTTP 409 / CLI exit 75 mapping |
| Dashboard mutating endpoint の CSRF | bearer token + Origin/Host/Content-Type 検証 + 127.0.0.1 bind |
| preset 適用で credentials 取込み・既存 `.agents` 破壊 | path traversal / blacklist / atomic apply / XDG backup / SHA256 manifest |
| SPEC trace gate 違反 | 新 failure.code / audit kind を core に入れる PR で SPEC §4.2.1.1 / §10.2.2.2 を必ず同時更新 |
| assets-hygiene gate 違反 | Dashboard を `packages/dashboard/` に分離、CLI bin は `bun build` self-contained 維持 |

## 付録

- takt 参考: <https://github.com/nrslib/takt/tree/main/builtins/en/facets/{instructions,personas}>
- skill コピー元: `tdd-workflow` / `general-review` (commit hash で pin、PR 内に明記)
- 実装オペレーター手順 (`find-skills` / `create-skill` 等) は CONTRIBUTING に分離。autokit runtime とは別レイヤ
