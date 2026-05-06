# 横断仕様 (cross-cutting)

> Scope: Phase 1〜4 を貫く SPEC trace gate / 実装順序 / リスク表 / CI gate 緑化義務。

## ステータス

- バージョン: v0.2.0+ (Phase 1〜4 共通)
- 関連: `docs/references/agent-autokit_phase1-3_implementation_plan.md` §「実装順序」「主なリスクと対策」
- 既存 SPEC との関係: `docs/SPEC.md` §4.2.1.1 (failure.code 列挙) / §10.2.2 (audit イベント) / §11.6 (assets hygiene CI) を引用 (改変なし)
- 関連 issue / PR: TBD

## 観測可能な完了条件 (AC)

- 新 `failure.code` を含む実装 PR で `bash scripts/check-trace.sh` が緑 (SPEC §4.2.1.1 ↔ §10.2.2.2 1:1 整合)
- 新 audit kind を含む実装 PR で SPEC §10.2.2.1 (操作系) または §10.2.2.2 (失敗系) のいずれかに同 PR で追記
- assets-hygiene 関連の構造変更 PR で `bash scripts/check-assets-hygiene.sh` が緑 (`packages/serve/` 追加 PR / preset backup 配置 PR を含む)
- 実装順序 (本書 §「実装順序」16 step) のいずれの中間 step を merge しても既存 e2e が緑 (旧 tasks.yaml 互換 / 既存 CLI exit code 0/1/75 維持)

---

## 1. 新 `failure.code` (SPEC §4.2.1.1 への追加候補)

実装 PR で **必ず同 PR 内** に SPEC §4.2.1.1 表 + §10.2.2.2 audit kind リストを追記する (既存 PLAN 重要原則 10 / `scripts/check-trace.sh` 1:1 trace gate 準拠)。本書では追加 `failure.code` の意味のみ列挙し、SPEC.md 自体は本タスクで改変しない。

| code | 発火 state | 発火 phase | 記録先 | 意味 | 関連 §  |
|---|---|---|---|---|---|
| `effort_unsupported` | failed | 全 agent_phase 7種 | `tasks.yaml.failure` (issue 単位) | `effort` 解決時に `unsupported_policy=fail` でサポート外 (effort, provider, model) 組合せを検出 | Phase 1 §3.3 |
| `preset_path_traversal` | (preset apply abort) | — (preset 経路 / state machine 不経由) | **`tasks.yaml` 不書込** + audit log + CLI exit 1 | preset archive 展開時に絶対 path / `..` / symlink / NUL byte / 親 chain symlink を検出 | Phase 3 §3.1 |
| `preset_blacklist_hit` | (preset apply abort) | — (preset 経路 / state machine 不経由) | **`tasks.yaml` 不書込** + audit log + CLI exit 1 | preset 展開先 path / コンテンツ署名が blacklist (`.env*` / `.codex/**` / `.claude/credentials*` / `id_rsa*` / `*.pem` / `*.key` / SSH PRIVATE KEY 等) にヒット | Phase 3 §3.1.2 |

`preset_*` 系 failure.code は既存 `symlink_invalid` (SPEC §4.2.1.1 「(init abort)」) と同じ semantics で運用する: state machine を経由せず、`tasks.yaml` (issue 単位 task entry) には書込まず、CLI exit 1 + 専用 audit log のみで完結する。SPEC §4.2.1.1 表に追加する際は state 列を「(preset apply abort)」、phase 列を `—` で記述する責務。

#### 1.1 `failure.message` redaction 規約 (新 3 failure.code 共通)

新 3 failure.code は機構上 path / pattern / effort tuple を含むため、`failure.message` / audit details に以下の redaction を **必ず適用**:

- `sanitizeLogString` (SPEC §4.6.2 既存) を必須通過
- `$HOME` 配下の絶対パスは `~/...` 化
- repo root 配下は `<repo>/...` 化
- blacklist hit はカテゴリ表現 (`<blacklist:credentials>` / `<blacklist:env>` / `<blacklist:ssh-key>` / `<content-signature:openssh-private-key>` 等) に置換し、literal pattern / 攻撃者がアクセス試行したファイル名は **非開示**
- effort tuple `(effort, provider, model)` のみ literal で許容 (機微情報なし)

AC「`failure.message` に `$HOME` 絶対パスが含まれない fixture」「blacklist hit message にカテゴリ表現のみが含まれる fixture」を追加。

**既存 `failure.code` で再利用 (新規追加なし)**:

| code | 用途 | 引用 § |
|---|---|---|
| `review_max` | review-fix loop 上限到達 | SPEC §4.2.1.1 既存 |
| `ci_failure_max` | ci-fix loop 上限到達 | SPEC §4.2.1.1 既存 |
| `prompt_contract_violation` | self-correction retry 後も契約違反 (`runtime.phase_self_correct_done=true` で 2 回目検出) | SPEC §4.2.1.1 既存 |
| `phase_attempt_exceeded` | phase ごとの試行上限到達 | SPEC §4.2.1.1 既存 |
| `lock_host_mismatch` | **CLI 経路のみ** (SPEC §4.2.1.1 既存 = 起動拒否 / exit 1 / `--force-unlock`)。Phase 2A `autokit serve` 経路は **流用しない** — serve は fast-path 409 (`tasks.yaml` 不書込、`failure.code` 不発火、`phase2-serve-dashboard.md` §1.2 / §1.5 参照) で完結 | SPEC §4.2.1.1 既存 / Phase 2 §1.2 |

実装 PR (Phase 1 §7 / Phase 3 §3) で SPEC §4.2.1.1 表 / §10.2.2.2 リストの行追加と `packages/core/src/failure-codes.ts` 配列の追加を同 PR で行う (既存重要原則 10 / `scripts/check-trace.sh` を緑化)。

## 2. 新 audit kind

### 2.1 操作系 audit kind (§10.2.2.1 への追加候補、`failure.code` に紐付かない運用イベント)

| kind | 発火タイミング | 関連 § |
|---|---|---|
| `effort_downgrade` | `effort.unsupported_policy=downgrade` でサポート外組合せが ladder (`high → medium → low → auto`) で 1 段階落ちた時 | Phase 1 §3.3 |
| `phase_self_correct` | `prompt_contract_violation` 検出 → self-correction retry の `runtime.phase_self_correct_done=false → true` 遷移時 | Phase 1 §7.2 |
| `phase_override_started` | `autokit run --phase / --provider / --effort` の per-run override 受理時 | Phase 1 §6 |
| `phase_override_ended` | override の `expires_at_run_id` 到達 + run 終了時 | Phase 1 §6 |
| `preset_apply_started` | `autokit preset apply <name>` の staging 展開開始 | Phase 3 §2 |
| `preset_apply_finished` | atomic rename で `.agents/` 全体差し替え完了 | Phase 3 §2 |

### 2.2 失敗系 audit kind (§10.2.2.2 への追加候補、`failure.code` 1:1)

| kind = failure.code | 関連 § |
|---|---|
| `effort_unsupported` | Phase 1 §3.3 |
| `preset_path_traversal` | Phase 3 §3.1 |
| `preset_blacklist_hit` | Phase 3 §3.1 |

`scripts/check-trace.sh` は §4.2.1.1 の `failure.code` 列と §10.2.2.2 の `kind` 列の集合一致を機械検査する。実装 PR で **同 3 行を §4.2.1.1 表 + §10.2.2.2 リストの両方** に追加する責務 (PLAN 重要原則 10)。

## 3. 新 `TransitionEvent` / state-machine 不変条件との整合

SPEC §5.1 不変条件: **1 transition で state または runtime_phase が必ず変化**。subphase 移行 / runtime field 更新のみで state / runtime_phase が動かないイベントは TransitionEvent 化しない方針 (現行 E01〜E40 全 case が state または runtime_phase を変える)。

本 Phase で導入する 3 イベントはこの不変条件を保つため **TransitionEvent 化しない**:

| イベント名 | 扱い | 配置 | 関連 § |
|---|---|---|---|
| `phase_self_correct` | **operational audit kind のみ** (§2.1) + `runtime.phase_self_correct_done` field 更新 | workflows 内 retry orchestrator (`runWithSelfCorrection`、§7 命名 mapping) | Phase 1 §7.3 |
| `phase_override_started` | **operational audit kind のみ** (§2.1) + `runtime.phase_override` field 更新 | CLI override receiver / state machine 不経由 | Phase 1 §6 |
| `phase_override_ended` | **operational audit kind のみ** (§2.1) + `runtime.phase_override=null` 復帰 | run 終了 / `expires_at_run_id` 到達検査 | Phase 1 §6 |

### 3.1 既存 E34 condition 改訂 (実装 PR で同 PR 更新)

既存 **E34 (`prompt_contract_violation`)** の condition 列を同 PR で改訂:

- 旧: 「prompt_contract 違反 (`status=need_input` で `default` 欠落 等)」即時 `failed`
- 新: 「prompt_contract 違反 **+** `runtime.phase_self_correct_done=true`」で `failed`
- `false` 状態の 1 回目違反は **state-machine event 化せず** workflows 内 retry orchestrator (`phase1-core-cli-runner.md` §7.3) で `phase_self_correct_done=false → true` の field 更新 + audit kind `phase_self_correct` 発火で同 phase 内 retry へ進む

### 3.2 採番

state-machine.ts の `TransitionEvent` union に **新規追加なし** (§3 の 3 イベントは TransitionEvent 化しないため)。実装側でやむを得ず TransitionEvent 化が必要になった場合のみ SPEC §5.1 表に **E41 以降** の連番を割当てる (現行最終 = E40 `merged | (終端)`、§5.1.3 復帰先表は不変)。

## 4. SPEC trace gate 同 PR 更新ルール

`docs/references/agent-autokit_phase1-3_implementation_plan.md` §7.4 + 既存 PLAN 重要原則 10 を再掲。

実装 PR で `failure.code` を新設する場合、**必ず同 PR で**:

1. `packages/core/src/failure-codes.ts` の配列に追加。
2. `docs/SPEC.md` §4.2.1.1 表に行追加 (state / 意味)。
3. `docs/SPEC.md` §10.2.2.2 リストに `- \`<code>\`` 行追加 (失敗系 kind)。
4. `bash scripts/check-trace.sh` をローカル実行し緑確認。
5. 必要なら `packages/core/src/logger.ts` の `failureAuditKinds` (= `failureCodes`) の型推論で自動同期されることを確認 (現状 `logger.ts:24` の `failureAuditKinds = failureCodes` 規約)。

操作系 audit kind を新設する場合は §10.2.2.1 表のみ追加し、`packages/core/src/logger.ts` の `operationalAuditKinds` 配列 (`logger.ts:26-41`) に追加する (1:1 trace 対象外)。

## 5. 実装順序 (16 step)

`docs/references/agent-autokit_phase1-3_implementation_plan.md` §「実装順序」をそのまま転記。step 13 を「user-guide のみ」に縮小し SPEC 更新は各機能 PR に分散する方針。

1. `packages/core/src/capability.ts` 新設 + `effort-resolver.ts` 新設 + `config.ts` に effort / capability validation 追加
2. `TaskEntry.runtime` 拡張 (`resolved_effort` / `phase_self_correct_done` / `phase_override` / `provider_sessions` 統合) + zod default で旧 yaml 互換
3. `AgentRunInput` に effort / effective permission を追加
4. runner の phase 固定制約を capability 判定へ置換 (Claude `allowed_tools` / `denied_tools` 動的化、`write_path_guard` hook 新設、Bash allowlist)
5. Codex runner の effort 反映 (`--reasoning-effort`) と payload schema 共通化 (validate のみ、JsonSchema は provider-specific 維持)
6. Claude runner の effort profile 変換 (model / max_turns / timeout / prompt policy)
7. state-machine の **既存 E34 condition 改訂** (`runtime.phase_self_correct_done=true` 必須化、§3.1) + 新 failure.code / audit kind を SPEC §4.2.1.1 / §10.2.2.2 同 PR 更新 (state-machine `TransitionEvent` union への新規追加は **なし**、§3.2)
8. `doctor` に provider / effort / prompt / permission 検証を追加 + CLI override の安全 fail-closed
9. review-fix / ci-fix loop の E2E テスト追加 (audit kind 列で assert、`fakeGh` 拡張)
10. logs / diff の sanitize / blacklist hunk 除去
11. `process-lock.ts` + `autokit serve` (HTTP/JSON only、bearer/Origin/Host) + 401/403/409 E2E
12. `assets-writer.ts` 新設 + preset 構造と `list/show/apply` (path traversal / blacklist / atomic / XDG backup)
13. 初期 preset 追加 (default / laravel-filament / next-shadcn / docs-create)
14. skills / prompts / agents を見直して改善 (Phase 4)
15. user-guide / dev-guide を更新 (SPEC は step 1, 7, 11, 12 で機能と同 PR 更新済み)
16. (別 issue) Dashboard UI (Phase 2B)

step 7, 11, 12 の各 PR で SPEC §4.2.1.1 / §10.2.2.2 を 1:1 trace 緑で更新する責務 (本書 §4)。

## 6. リスクと対策

`docs/references/agent-autokit_phase1-3_implementation_plan.md` §「主なリスクと対策」をそのまま転記。

| リスク | 対策 | 関連 § |
|---|---|---|
| provider 自由化で安全境界が曖昧 | capability table を core 単独所有 SoT 化、CLI override で permission を変更不可 | Phase 1 §1, §6 |
| Claude write phase が過剰権限 | write profile のみ `allowed_tools` 拡張 + `write_path_guard` hook + Bash allowlist (git/gh 除外) | Phase 1 §5.1 |
| effort の意味が provider/model でズレる | native effort と autokit profile を `effort-resolver.ts` で分離、downgrade ladder と audit kind | Phase 1 §3 |
| schema 共通化で構造化出力が壊れる | validate は共通、provider strict schema は provider-specific 維持 (Codex `anyOf` / null 維持) | Phase 1 §5.2 |
| prompt カスタムで構造化出力が壊れる | prompt_contract test と self-correction retry 1 回 + state-machine 経由 | Phase 1 §7.2, Phase 4 §2 |
| Dashboard と CLI の二重起動 | `flock(2)` based `.autokit/.lock` + HTTP 409 / CLI exit 75 mapping | Phase 2 §1.2 |
| Dashboard mutating endpoint の CSRF | bearer token + Origin/Host/Content-Type 検証 + 127.0.0.1 bind | Phase 2 §1.3 |
| preset 適用で credentials 取込み・既存 `.agents` 破壊 | path traversal / blacklist / atomic apply / XDG backup / SHA256 manifest | Phase 3 §3 |
| SPEC trace gate 違反 | 新 failure.code / audit kind を core に入れる PR で SPEC §4.2.1.1 / §10.2.2.2 を必ず同時更新 | 本書 §4 |
| assets-hygiene gate 違反 | Dashboard を `packages/dashboard/` に分離、CLI bin は `bun build` self-contained 維持 | Phase 2 §2 |

## 7. 命名 mapping (計画書 ↔ コード SoT)

計画書命名と実装命名の差異を吸収する mapping 表。仕様書間で命名揺れが起きないよう本表を SSOT とする。

| 計画書命名 | コード SoT 命名 | 配置 |
|---|---|---|
| capability table | `CapabilityRow[]` | `packages/core/src/capability.ts` (新設) |
| effort resolver | `EffortResolver` | `packages/core/src/effort-resolver.ts` (新設) |
| autokit profile (effort) | `resolved_effort` | `tasks.yaml.runtime.resolved_effort` |
| write profile path guard | `write_path_guard` (Claude PreToolUse hook) | `packages/claude-runner/src/index.ts` (新規 fn) |
| run-once override | `phase_override` (`expires_at_run_id` 付) | `tasks.yaml.runtime.phase_override` |
| process lock | `acquireRunLock(repo)` | `packages/core/src/process-lock.ts` (新設) |
| preset assets writer | `applyPreset(name)` / `assets-writer.ts` | `packages/core/src/assets-writer.ts` (新設) |
| sanitize hunk filter | `filterDiffHunks(diff)` | `packages/cli/src/diff.ts` (新設想定) |
| doctor override fail-closed checker | `validatePhaseOverride()` | `packages/cli/src/index.ts` の doctor 系 (`index.ts:622-694` 周辺) |
| self-correction retry orchestrator | `runWithSelfCorrection()` | `packages/workflows/src/index.ts` (現 review/fix loop `index.ts:351-457` 周辺に統合) |

## 8. CI gate 緑化義務 (本タスクと本書の境界)

本タスク (`docs/spec/` 仕様書ドラフト) では:

- SPEC.md は **不変**。`scripts/check-trace.sh` は仕様書ドラフト前後で同じ exit code を返す (= 既存 §4.2.1.1 / §10.2.2.2 1:1 整合維持)。
- `scripts/check-assets-hygiene.sh` は本タスクで影響なし (CLI bin / publish 候補に変更なし)。

実装 PR (上記 §5 step 1〜14) では:

- 新 `failure.code` / audit kind を含む PR は SPEC.md を同 PR で更新し `scripts/check-trace.sh` を緑化。
- `packages/serve/` / `packages/dashboard/` を追加する PR は CLI bin に巻き込まないことを `scripts/check-assets-hygiene.sh` で確認。
- preset backup 配置 (`${XDG_STATE_HOME:-~/.local/state}/autokit/backup/<repo>/<timestamp>/`) は repo tree 外のため `scripts/check-assets-hygiene.sh` の禁止 glob を素通りしない。

## 将来拡張 / 残課題

- `effort` の `minimal` / `xhigh` / `max` 値: Claude / Codex の native サポート時に追加し SPEC で明示 (Phase 1 §3.1 縮約理由)。
- preset `apply --dry-run`: Phase 3+ で検討 (Phase 3 §2)。
- preset `export <name>`: 受信者・ユースケース未確定のため Phase 3+ (Phase 3 §2)。
- Phase 2B Dashboard: 別 issue (本書 §5 step 16)。
- audit kind `effort_downgrade` の rate cap: 既存 `runner_idle` (SPEC §10.2.2.1) と同様の指数増 cap を実装時に検討。
