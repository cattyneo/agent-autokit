# Phase 1: CLI / Core / Runner 安定化

## ステータス

- バージョン: v0.2.0+ (Phase 1)
- 関連: `docs/references/agent-autokit_phase1-3_implementation_plan.md` §「Phase 1: CLI / Core / Runner 安定化」全体
- 既存 SPEC との関係 (引用のみ、改変なし):
  - `../SPEC.md#14-用語` (用語: `runtime_phase` / `agent_phase` / `prompt_contract`)
  - `../SPEC.md#22-役割分担-phase--provider` (本 Phase で capability table 由来へ移行)
  - `../SPEC.md#41-configyaml` (`effort` ブロック / `runner_timeout.<phase>_ms` `optional()` 化)
  - `../SPEC.md#42-tasksyaml` (`runtime` フィールド拡張)
  - `../SPEC.md#4211-failurecode-固定列挙` (新 `failure.code` を `cross-cutting.md` §1 経由で同 PR 追記)
  - `../SPEC.md#51-state-遷移表` (**新規 `TransitionEvent` 追加なし**、既存 **E34 condition 改訂のみ** を `cross-cutting.md` §3 / §3.1 経由で同 PR 反映)
  - `../SPEC.md#1143-claude-runner-の安全境界` (write profile + `write_path_guard` 拡張)
  - `../SPEC.md#1022-audit-イベント` (新 audit kind を `cross-cutting.md` §2 経由で同 PR 追記)
- 関連 issue / PR: TBD

## 観測可能な完了条件 (AC)

計画書「Phase 1 完了条件 (観測可能)」をそのまま転記。

- [ ] default provider split で E2E が完走 (audit kind 列で assert)
- [ ] 任意 phase の provider を config で変更でき、capability table が `(phase, provider)` の許可組を fail-closed で検証
- [ ] effort を phase ごとに設定でき、`runtime.resolved_effort` に解決後値が保存される
- [ ] invalid provider / effort / permission を `doctor` が検出し exit code 非 0
- [ ] review-fix loop / CI-fix loop の停止理由が `failure.code ∈ {review_max, ci_failure_max, prompt_contract_violation, phase_attempt_exceeded}` のいずれかで記録される
- [ ] self-correction retry が 1 回だけ走る E2E (`runtime.phase_self_correct_done=true`)
- [ ] `run / resume / retry / cleanup` の後方互換 (旧 `tasks.yaml` の zod default 適用 + 既存 e2e 全緑)
- [ ] 新 `failure.code` / audit kind を含む PR で `bash scripts/check-trace.sh` が緑

## 1. Capability table を SoT 化

### 1.1 配置

- 新ファイル: `packages/core/src/capability.ts`
- 責務: `(phase, provider, permission_profile)` の許可組と provider 別 derive 関数を **core 単独所有 SoT** として保持。

### 1.2 型シグネチャ

```ts
type Phase = "plan"|"plan_verify"|"plan_fix"|"implement"|"review"|"supervise"|"fix";
type Provider = "claude"|"codex";

interface CapabilityRow {
  phase: Phase;
  provider: Provider;
  permission_profile: "readonly_repo" | "readonly_worktree" | "write_worktree";
  derive_claude_perm(): { allowed_tools: string[]; denied_tools: string[]; hook: "readonly_path_guard" | "write_path_guard" };
  derive_codex_perm(): { sandbox: "read-only" | "workspace-write"; network: "off" };
}
```

`Phase` 型は `agent_phase` (`runtime_phase` 9 種から `ci_wait` / `merge` を除いた 7 種、SPEC §1.4) と完全一致。`ci_wait` / `merge` は core-only で provider / effort / capability 設定対象外。

### 1.3 責務分担

| 主体 | 責務 |
|---|---|
| `packages/core/src/capability.ts` (新設) | 全 7 phase × 2 provider の許可組と derive 関数を SoT として保持 |
| runner / workflows / doctor / `init.ts` | capability table を `import` して assert / 構築 / 検証に徹する |
| `packages/claude-runner/src/index.ts` | `claudeRunnerPhases` ホワイトリスト (`claude-runner/src/index.ts:22`) を **廃止** し、`derive_claude_perm()` 由来へ置換 |
| `packages/cli/src/init.ts` | `DEFAULT_CONFIG_YAML` リテラル (`init.ts:29-32`) を core `DEFAULT_CONFIG` を YAML serialize に置換 (もしくは `assets/.autokit/config.yaml.template` 外出し + CI gate) |

### 1.4 deprecate path

既存 `permissions.claude.allowed_tools` 設定 (SPEC §4.1 / §11.4.3 B) は deprecate path を明記:

- 当面は capability 由来の許可と union (mode-keyed)
- `doctor` で warn ログを出し利用者に migrate 通知
- v0.3.0 以降で SPEC §11.4.3 B から外し capability 派生のみに統一

### 1.5 permission profile 表 (対象 7 phase)

| phase | scope | write | claude profile | codex sandbox |
|---|---|---:|---|---|
| plan | repo | no | readonly_repo | read-only |
| plan_verify | repo | no | readonly_repo | read-only |
| plan_fix | repo | no | readonly_repo | read-only |
| implement | worktree | yes | write_worktree | workspace-write |
| review | worktree | no | readonly_worktree | read-only |
| supervise | worktree | no | readonly_worktree | read-only |
| fix | worktree | yes | write_worktree | workspace-write |

`ci_wait` / `merge` は core-only 。capability table / permission profile / dashboard 表示の provider 列対象外。

## 2. Provider 自由切替

- `config.phases.<phase>.provider` を実行時に尊重 (`packages/core/src/config.ts` 既存 schema)
- runner の phase 固定制約は capability table 由来へ置換 (本書 §1.3)
- 不正な provider / permission 組み合わせは `doctor` と `run` 開始時に fail-closed
- 安全境界は provider ではなく phase 側で固定。CLI override で緩めない (本書 §6)

実装メモ: SPEC §2.2 「役割分担 (Phase × Provider)」表は v0.1.0 では Claude phase 4 種 / Codex phase 3 種固定だが、v0.2.0 で capability table 由来へ移行する旨を SPEC §2.2 同 PR 更新時に注記する (本書 §1 step 1 の同 PR で更新)。

## 3. Effort policy

### 3.1 EffortLevel

```ts
type EffortLevel = "auto" | "low" | "medium" | "high";
```

縮約理由: `minimal` / `xhigh` / `max` は Claude / Codex のいずれも native 値を持たず、autokit profile としても medium / high と挙動分離が困難。dead option 化を避けるため Phase 1 は 4 値に絞る。将来 native サポート時に追加し SPEC で明示する (`cross-cutting.md` 「将来拡張」)。

### 3.2 Effort × provider × profile マッピング

SoT は `packages/core/src/effort-resolver.ts` (新設)。

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

- `auto` 解決時点: core `effort-resolver.ts` が **phase 開始直前** に解決。runner は受け取った値を CLI 引数化のみ
- Claude は native effort flag を前提にしない (autokit profile)
- Codex は `--reasoning-effort` を runner 起動時に明示

### 3.3 timeout 合成規則

`effort` 由来 timeout vs `runner_timeout.<phase>_ms` の優先順位:

- `runner_timeout.<phase>_ms` がユーザー明示 (config に値あり) → そちら優先。effort 由来 timeout は無視
- `runner_timeout.<phase>_ms` 未設定 (zod default 適用) → effort 由来値を採用
- `runner_timeout.*_idle_ms` (idle timeout) は effort 軸対象外。既存 config 値を全 effort 共通で適用 (SPEC §4.1 既存)
- `effort-resolver.ts` の出力 `resolved_effort.timeout_ms` は **最終解決値** (上記優先順位適用後)。runner には解決値のみが渡る
- 判定基準: zod schema で「ユーザー明示」と「default 適用」を区別する。`runner_timeout` の各 `<phase>_ms` は `optional()` を維持し、`undefined` を「ユーザー未設定」、値ありを「ユーザー明示」と判定

実装注: SPEC §4.1 / `packages/core/src/config.ts:142-160` で `plan_ms` / `implement_ms` / `review_ms` / `default_ms` 等が現状 `.default(...)` 呼出で「default 適用」と「ユーザー明示」を区別不可。本 Phase で `optional()` + 解決時に default 値適用へ migrate する。

### 3.4 Unsupported policy と downgrade ladder

`config.yaml` 拡張:

```yaml
effort:
  default: medium
  unsupported_policy: fail   # fail | downgrade
```

- `fail`: 解決時点で `failure.code=effort_unsupported` で停止
- `downgrade`: ladder `high → medium → low → auto` の順に **1 段階だけ** 落とす。downgrade 発生時:
  - **`failure.code=effort_downgraded` ではなく** 操作系 audit kind `effort_downgrade` を log に残す (`cross-cutting.md` §2.1)
  - `runtime.resolved_effort` に解決後値を保存
  - silent 落としは禁止
- ladder 最終フォールバック: `auto` も不可なら `fail` 同等で停止 (`failure.code=effort_unsupported`)

### 3.5 段階導入オプション

実装コスト懸念がある場合、Phase 1 を以下 2 段階に分割可:

- **1a**: Codex のみ effort 反映、Claude は受理して no-op (`resolved_effort` に値だけ記録)
- **1b**: Claude も autokit profile 変換を実装 (本書 §5.1)

## 4. Config / Runtime / Tasks 拡張

### 4.1 `config.ts` 拡張

`packages/core/src/config.ts` に以下追加:

- `PhaseConfig.effort?: EffortLevel`
- top-level `effort.default: EffortLevel` (default `medium`)
- top-level `effort.unsupported_policy: "fail"|"downgrade"` (default `fail`)
- `runner_timeout.<phase>_ms` を `optional()` 化 (本書 §3.3)

### 4.2 `TaskEntry.runtime` 拡張

`packages/core/src/tasks.ts:131-140` 現 schema (`phase_attempt` / `last_event_id` / `interrupted_at` / `previous_state` / `resolved_model`) に以下を追加 (zod schema、旧 yaml 互換 default null 必須):

```ts
runtime: {
  // 既存フィールド維持 (phase_attempt / last_event_id / interrupted_at / previous_state / resolved_model)
  resolved_effort?: { phase: Phase; provider: Provider; effort: EffortLevel; downgraded_from?: EffortLevel } | null;
  phase_self_correct_done?: boolean | null;  // 本書 §7.3 self-correction
  phase_override?: { phase: Phase; provider?: Provider; effort?: EffortLevel; expires_at_run_id: string } | null;  // 本書 §6 override
}
```

### 4.3 `provider_sessions` 統合

現 schema (SPEC §4.2 / `tasks.ts:114-122`) は phase ごと `claude_session_id` / `codex_session_id` 別フィールドだが、provider 自由切替 + override で同 phase 内 provider 切替が起きうるため統合:

```ts
provider_sessions: {
  [phase: Phase]: { claude_session_id?: string; codex_session_id?: string; last_provider?: Provider } | null;
}
```

#### 4.3.1 旧 yaml 互換 (zod transform / preprocess)

zod `default()` は値補完であり key rename / structure migration を行わない。本 Phase では **`z.preprocess` で旧 → 新 schema migration を必ず実装** する。

migration 規則 (SPEC §2.2 既存「役割分担 (Phase × Provider)」表からの逆引き、現 default provider 対応):

| 旧 schema (per phase) | 新 schema (per phase) | `last_provider` 推定 |
|---|---|---|
| `plan: { claude_session_id }` | `plan: { claude_session_id, last_provider: "claude" }` | `claude` (SPEC §2.2 既定) |
| `plan_verify: { codex_session_id }` | `plan_verify: { codex_session_id, last_provider: "codex" }` | `codex` |
| `plan_fix: { claude_session_id }` | `plan_fix: { claude_session_id, last_provider: "claude" }` | `claude` |
| `implement: { codex_session_id }` | `implement: { codex_session_id, last_provider: "codex" }` | `codex` |
| `review: { claude_session_id }` | `review: { claude_session_id, last_provider: "claude" }` | `claude` |
| `supervise: { claude_session_id }` | `supervise: { claude_session_id, last_provider: "claude" }` | `claude` |
| `fix: { codex_session_id }` | `fix: { codex_session_id, last_provider: "codex" }` | `codex` |

migration 関数 (`packages/core/src/tasks.ts` 内 preprocess) の責務:

1. 旧 schema 形 (片側 session_id のみ) を検出
2. 該当 phase の SPEC §2.2 既定 provider を `last_provider` に注入
3. 反対側の `*_session_id?` は `undefined` 維持
4. 完全な空 (両 null) は `last_provider: null` で透過

旧 yaml (`{ claude_session_id }` 単独) を持つ既存タスクで `autokit resume` した際、本 migration により schema 検証通過 + session 復元先 provider 判定が確定する。**後方互換 AC「旧 tasks.yaml の zod default 適用 + 既存 e2e 全緑」は preprocess migration を含めて検証**。

### 4.4 維持する制約

- `prompt_contract` は phase と 1:1 (SPEC §9.4.2)
- read-only phase で書き込み不可 (CLI override でも緩めない、本書 §6)
- network 設定は既存方針を維持 (SPEC §11.4.3 / §9.7.2)
- provider / model / effort が不明な場合は `doctor` で検出 (本書 §8)

## 5. Runner 更新

### 5.1 Claude runner 全面書換

現状 (`packages/claude-runner/src/index.ts`):

- ホワイトリスト: `claudeRunnerPhases=["plan","plan_fix","review","supervise"]` (`claude-runner/src/index.ts:22`)
- `permissions.mode!=="readonly"` 全 phase 拒否 (`claude-runner/src/index.ts:262`)
- `DENIED_TOOLS=["Bash","Edit","Write","WebFetch","WebSearch"]` 常時拒否 (`claude-runner/src/index.ts:80`)
- readonly path guard hook で fail-closed (`buildClaudePathGuardSettings`, `claude-runner/src/index.ts:318-332`)

書換後:

- `claudeRunnerPhases` 廃止 → capability table の `derive_claude_perm()` 由来 (本書 §1)
- `assertClaudeInput` (`claude-runner/src/index.ts:246-283`) の mode/scope 分岐を `(phase, permission_profile)` matrix で書換
- `DENIED_TOOLS` 動的化:
  - `readonly_*` profile: 既存どおり `Edit/Write/Bash/WebFetch/WebSearch` を deny
  - `write_worktree` profile: `Edit/Write/Bash` を `allowed_tools` に昇格 (`WebFetch/WebSearch` は引続き deny)
- write profile 用 PreToolUse hook 新設: `write_path_guard`
  - `Edit/Write/Bash` の path / cmd を実 worktree 配下 (`.autokit/worktrees/issue-N`) に閉じ込め
  - 以下への書込を fail-closed:
    - `.env*`
    - `.codex/**`
    - `.claude/credentials*`
    - `id_rsa*`
    - `*.pem`
    - `*.key`
- Bash 許可コマンド allowlist: `build` / `test` / `lint` / `format` 系
- Bash deny: `git` / `gh` は core 単独所有 (SPEC §2.1) のため runner 直叩き禁止 (allowlist から除外)
- effort は autokit profile (本書 §3.2) として model / max_turns / timeout / prompt policy に変換

### 5.2 Codex runner

`packages/codex-runner/src/index.ts` 更新:

- 全 phase を受けられるよう `validatePromptContractPayload` (受理側意味論) を **共通化**
- ただし **`*JsonSchema` (provider に渡す strict schema) は provider-specific のまま**:
  - `codexPromptContractJsonSchema` (`codex-runner/src/index.ts:403-429`) の `data/question required + null union + plan-verify result/findings anyOf` を維持
  - `data` 中身だけ phase 全種に拡張
- `normalizeCodexFinalPayload` (`codex-runner/src/index.ts:548-557`) で null を剥がす既存処理を維持
- read-only profile は sandbox `read-only`、write profile は `workspace-write`
- effort は native `--reasoning-effort` で渡す (現状 `buildCodexArgs` (`codex-runner/src/index.ts:152-178`) に未実装、本 Phase で追加)
- session resume / JSONL parse は既存設計を維持

## 6. CLI override の安全制約

`autokit run --phase <phase> --provider <claude|codex> --effort <level>` は以下の制約下のみ受理:

### 6.1 受理条件 (CLI 表面の許容範囲)

- **`permission_profile` 軸 (readonly_repo / readonly_worktree / write_worktree) を CLI から直接変更不可**。capability table の `(phase, provider)` 許可組のみ受理し、profile は table から **導出** する
- override は state-machine を経由しない **runtime field 更新 + 操作系 audit kind** で表現 (`cross-cutting.md` §3 改訂後): `runtime.phase_override` 永続化 + `phase_override_started` / `phase_override_ended` audit kind 発火、SPEC §5.1 不変条件 (= 1 transition で state または runtime_phase が変化) を保つ
- override 永続性: **1 run 限り** (`runtime.phase_override.expires_at_run_id` で固定)。次回 run には引き継がない
- `provider_sessions.<phase>` は本書 §4.3 拡張で `{claude_session_id?, codex_session_id?, last_provider?}` 化済み。override 後の resume も session 復元可能
- runner 直叩き不可 (override 解決後の effective `(phase, provider, effort, profile)` も capability table の許可組のみ runner spawn)

### 6.2 fail-closed 検査 (provider override で derive 結果が緩む場合の二重防御)

CLI override で許容されるのは `(provider, effort)` のみ。`permission_profile` 自体は §6.1 で禁止だが、**provider 切替で derive 関数の出力差異が phase 既定より緩む** ケース (例: phase 既定 = Claude readonly_worktree、override = Codex workspace-write) は physically 起こり得るため、`doctor` + run 開始時に以下を検出して fail-closed:

- override 後の **effective `derive_*_perm()` 出力** (allowed_tools / sandbox / network) が phase 既定 (= override なし時の derive 結果) より緩い → fail-closed (例: 既定 read-only sandbox なのに override で workspace-write になる)
- `(phase, provider)` が capability table 不許可組 → fail-closed
- override 解除 (run 終了) 時に `runtime.phase_override=null` に戻ることを reconcile で確認、stale override 残存は doctor で検出

## 7. Review / Fix ループ安定化

### 7.1 対象ループ

```text
review → supervise → fix → review
ci_wait → fix → ci_wait
```

### 7.2 停止条件 (観測可能 AC)

停止時に `tasks.yaml.failure.code` が以下のいずれかで記録される:

- `review_max` — `review.max_rounds` 到達 (SPEC §4.2.1.1 既存)
- `ci_failure_max` — `ci.fix_max_rounds` 到達 (SPEC §4.2.1.1 既存)
- `prompt_contract_violation` — 構造化出力契約違反 (self-correction retry も失敗、SPEC §4.2.1.1 既存)
- `phase_attempt_exceeded` — phase ごとの試行上限到達 (SPEC §4.2.1.1 既存)

audit log に固定 sequence で kind が記録される (例: `phase_started → review_finding_seen → fix_started → fix_finished → review_started`)。E2E は audit kind 列で assert (`packages/workflows/src/index.ts:351-457` ループ実装に合わせ E2E fixture 拡張)。

### 7.3 Self-correction retry

- `prompt_contract_violation` 検出時、**1 回限り** self-correction retry を許可
- 1 回判定: `runtime.phase_self_correct_done` フラグで管理 (本書 §4.2)
- 実装は **state-machine 経由ではなく** workflows 内の retry orchestrator (`cross-cutting.md` §7 mapping `runWithSelfCorrection`) で完結する。SPEC §5.1 不変条件 (1 transition = state or runtime_phase 変化) を保つため、self-correct retry 自体は state / runtime_phase を変えない (= state-machine event 化しない)
- 操作系 audit kind `phase_self_correct` を発火 (`cross-cutting.md` §2.1) し、`runtime.phase_self_correct_done=false → true` の field 更新で 1 回判定を永続化
- self-correction の resume / exit code 75 (TEMPFAIL) 整合: retry 中も checkpoint を進め、途中中断しても `resume` で続行可能 (`phase_self_correct_done=true` 状態の resume は self-correct 済み判定で次回違反は即 `failed`)

### 7.4 ci-fix loop と core 単独所有

- ci-fix の `gh pr checks` 等は core `gh.ts` argv builder 経由のみ (SPEC §2.1)
- E2E は既存 `fakeGh` パターン (`e2e/runners/full-run.test.ts`) を `gh pr checks` / `gh run view` に拡張
- `ci_wait` / `merge` が runner に届かない仕様 (SPEC §1.4 / §2.2) と矛盾しないよう、ci-fix loop は workflows + core のみで完結

### 7.5 SPEC trace 同 PR 更新

新 audit kind / failure.code は `cross-cutting.md` §1, §2 に列挙。core 実装と同 PR で SPEC §4.2.1.1 / §10.2.2.2 を必ず同時更新し `scripts/check-trace.sh` 1:1 trace gate を緑化する。

加えて、**SPEC §5.1 E34 (`prompt_contract_violation`) の発火条件 row 改訂** を同 PR で実施:

- 旧: 「prompt_contract 違反 (`status=need_input` で `default` 欠落 等)」即時 `failed`
- 新: 「prompt_contract 違反 + `runtime.phase_self_correct_done=true` (= self-correction retry 1 回目で再度違反)」で `failed`。`phase_self_correct_done=false` 状態の 1 回目違反は **state-machine 経由せず** workflows 内 retry orchestrator (`runWithSelfCorrection`) で field 更新 + audit kind `phase_self_correct` 発火で同 phase 内 retry へ進む (`cross-cutting.md` §3)

E34 row 改訂は state-machine.ts の event handler 改修と同 PR で SPEC §5.1 表の condition 列を更新する責務。

## 8. CLI 追加

```bash
autokit config show           # config 全体 + capability matrix を一画面で表示
autokit config validate       # doctor 相当 (lint/serialization のみ)
autokit logs --issue <n>      # tasks/<issue>/logs を sanitize 経由で表示 (本書 §9.1)
autokit diff --issue <n>      # working tree diff を blacklist hunk 除去 (本書 §9.2)
```

整理:

- `phase matrix` は `config show --matrix` に畳む (役割重複削減)
- `logs` / `diff` は `tail -f` / `git diff` で代替不能なペルソナ向け: rotated log の自動結合・sanitize 済み出力・blacklist hunk 除去
- 一時 override (本書 §6) は `run --phase / --provider / --effort` のみ

## 9. ログ・差分の sanitize / redact

### 9.1 logs 出力

- `autokit logs` 出力時に既存 `sanitizeLogString` (`packages/core/src/logger.ts:376-382`) で **再 sanitize** (二重 redact)
- rotated log を時系列結合してから sanitize

### 9.2 diff 出力

diff 出力は **2 段の redact** を必ず通過させる。path のみの blacklist では非ブラックリスト path に紛れ込んだ secret が漏洩するため、hunk body にも content redactor を必須適用する。

#### 9.2.1 path-based hunk 除去 (1 段目)

以下を含む hunk を **hunk 単位で削除しプレースホルダ表示**:

- `.env*`
- `.codex/**`
- `.claude/credentials*`
- `id_rsa*`
- `*.pem`
- `*.key`

working tree に operator が置いた credentials の差分が出力に混入するのを防ぐ。実装: `packages/cli/src/diff.ts` (新設想定) で `git diff` raw 出力 → hunk parser → 上記 path にマッチする hunk を `[REDACTED hunk: <path>]` プレースホルダに置換。

#### 9.2.2 content-based redaction (2 段目、全 hunk body 必須)

path-based 除去を通過した残り全 hunk の body に **`sanitizeLogString` (SPEC §4.6.2.2 token-like pattern + `logging.redact_patterns`) を必須適用**。`README.md` / `config/example.ts` 等の非ブラックリスト path に commit / staged された credential もマッチング行を `<REDACTED>` 化:

- GitHub PAT (`ghp_` / `github_pat_` / `gho_` 等)
- OpenAI API key (`sk-`)
- `Bearer <token>` / `Authorization:` header echo
- AWS / GCP credentials patterns
- `BEGIN PRIVATE KEY` / `ssh-rsa` (本書 SPEC §4.6.2.2 既存全集合)
- Claude / Codex subscription credentials JSON (refreshToken / oauthAccessToken / token field)
- `config.logging.redact_patterns` 追加分

#### AC 追加

- [ ] 非ブラックリスト path (`README.md` / `docs/example.md` 等) に dummy token (`ghp_xxx` / `sk-xxx` / `BEGIN OPENSSH PRIVATE KEY`) を含む staged 差分で、`autokit diff` 出力 / `GET /api/tasks/:issue/diff` 出力に token literal が含まれない fixture
- [ ] path-based 除去された hunk のプレースホルダ表示と content redaction された行の `<REDACTED>` 表示が **どちらも** 出力に含まれる (silent drop なし)

## 将来拡張 / 残課題

- `effort` の `minimal` / `xhigh` / `max` 値: native サポート時に追加 (本書 §3.1)
- 段階導入オプション 1a / 1b (本書 §3.5)
- `permissions.claude.allowed_tools` deprecate path 完全削除は v0.3.0 (本書 §1.4)
