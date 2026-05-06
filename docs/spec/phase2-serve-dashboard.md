# Phase 2: Local API server + Dashboard

## ステータス

- バージョン: v0.2.0+ (Phase 2)
- 関連: `docs/references/agent-autokit_phase1-3_implementation_plan.md` §「Phase 2: Local API server + Dashboard (issue 分割)」
- 既存 SPEC との関係 (引用のみ、改変なし):
  - `../SPEC.md#43-autokitlock` (`.autokit/lock` 単プロセス前提) — 本 Phase で cross-process lock を別ファイル `.autokit/.lock` で追加
  - `../SPEC.md#1022-audit-イベント` (新 audit kind なし、既存の `lock_seized` / `auto_merge_disabled` 等を流用)
  - `../SPEC.md#116-assets-hygiene-ci` (`packages/serve/` 追加でも CLI bin self-contained 維持)
  - `../SPEC.md#4211-failurecode-固定列挙` (`lock_host_mismatch` 既存を HTTP 409 へ転用)
- 関連 issue / PR: TBD (Phase 2A / Phase 2B を別 issue として分割)

Phase 2 は以下 2 issue に分割。MVP は **Phase 2A のみ必須**。

- **Phase 2A**: `autokit serve` (HTTP/JSON only) + cross-process lock + auth
- **Phase 2B**: Dashboard UI (Next.js + shadcn/ui or 軽量代替)

## 観測可能な完了条件 (AC)

### Phase 2A 完了条件 (MVP 必須)

- [ ] `autokit serve` が `127.0.0.1` bind で起動し、bearer token なしの mutating request を 401 で拒否
- [ ] 不正 Origin / Host / Content-Type を 403 で拒否する E2E
- [ ] `POST /api/run` 中に同 repo で `autokit run` を起動すると exit 75 + `failure.code=lock_host_mismatch`
- [ ] `tasks.yaml` の cross-process 並行書込が `flock(2)` で直列化される
- [ ] `GET /api/events` の SSE が p95 < 1s で push され、生 stdout が漏れない (sanitize 済み event のみ)
- [ ] `GET /api/tasks/:issue/diff` が credentials 含む hunk をプレースホルダ化 (`phase1-core-cli-runner.md` §9.2 と同等)

### Phase 2B 完了条件 (UI、別 issue)

- [ ] Dashboard から状態確認・run/resume/retry/cleanup を実行できる
- [ ] plan / review / diff を画面で確認できる
- [ ] CLI 単体運用と Dashboard 運用が同じ state を共有 (Phase 2A の lock + API 経由)

## 1. `autokit serve` (Phase 2A)

CLI runtime を利用するローカル API server。`packages/serve/` を新設し、`bun build` 可能な軽量 server (`Bun.serve` または `Hono`) を採用。Next.js runtime を CLI bin に巻き込まず、`scripts/check-assets-hygiene.sh` の `workspace:` / unresolved import 禁止に抵触させない。

### 1.1 API

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

mutating endpoint = `POST /api/{run,resume,retry,cleanup}`。SSE = `GET /api/events`。

### 1.2 Cross-process lock と排他制御

`tasks.yaml` の atomic write (SPEC §4.2 / `.autokit/lock`) は単プロセス OS rename のみ前提。serve 常駐後の **CLI 直叩き ↔ HTTP API ↔ 将来の Dashboard click** の三者間排他を新設:

| 項目 | 仕様 |
|---|---|
| 実装 | `packages/core/src/process-lock.ts` (新設) |
| ファイル | `.autokit/.lock` (既存 `.autokit/lock` (SPEC §4.3) とは別ファイル) |
| 機構 | `flock(2)` ベース |
| 取得 API | `acquireRunLock(repo)` |
| 取得失敗時 mapping | HTTP `409 Conflict` ↔ CLI `exit 75 (TEMPFAIL)` + `failure.code=lock_host_mismatch` (既存 `failure.code` を転用、SPEC §4.2.1.1) |
| holder 情報 | `.autokit/.lock` に PID / host / acquired_at を記録 |
| stale 検出 | 既存 `.autokit/lock` (SPEC §4.3.1) と同様の lstart / pid 死活確認で自動回収 |

`POST /api/run` 中に同 repo で `autokit run` を実行すると exit 75 + 「serve がロック中」ガイダンスを表示。

### 1.3 認可 / CSRF / DNS rebinding 対策

mutating endpoint と SSE は core の git/gh push / 自動 merge / branch 削除を直接トリガーする。最低限以下を必須:

| 観点 | 仕様 |
|---|---|
| **bind** | 既定 `127.0.0.1` または Unix domain socket。`0.0.0.0` 拒否 (config で明示 opt-in も拒否、warn でなく fail) |
| **bearer token** | 起動時生成、ファイル `${XDG_STATE_HOME:-~/.local/state}/autokit/serve.token` に mode `0600` で保存。CLI / Dashboard は同ファイル読込で同一トークンを共有 |
| **Origin / Sec-Fetch-Site** | `same-origin` ホワイトリスト必須。不一致は 403 |
| **Host header** | `127.0.0.1:PORT` / `localhost:PORT` 以外を 403 で拒否 (DNS rebinding 対策) |
| **Content-Type** | mutating endpoint は `application/json` 必須。`application/x-www-form-urlencoded` / `multipart/form-data` は拒否 (simple form CSRF 防止) |
| **`/api/events` (SSE)** | bearer + Origin + Host 同様。同時接続数上限を設定 |
| **404 / 401 切り分け** | 未認可リクエストが 401 で拒否される E2E を実装 |

### 1.4 Sanitize / redact 配信

- logs / events は logger 出力後の sanitize 済み event のみ配信。生 stdout 直結禁止 (SPEC §10.2 既存 `sanitizeLogString` を経由)
- diff は `phase1-core-cli-runner.md` §9.2 の blacklist hunk 除去後を配信
- レスポンスヘッダ: `Content-Type: text/plain; charset=utf-8` + `X-Content-Type-Options: nosniff`

### 1.5 実行制御

- `parallel: 1` を維持 (SPEC §1.3 非ゴール)
- API 操作は内部 workflow を呼ぶ (CLI 経路と同一の core API 経由)
- active task がある場合は 409 で拒否 (**fast-path** 、`failure.code` 発火なし。HTTP 状態のみ。同 process 内の active task 判定で本書 §1.2 process-level lock 取得前に early return)
- 本書 §1.2 の cross-process lock 取得失敗 (`flock(2)` 競合) は別経路: HTTP `409 Conflict` + `failure.code=lock_host_mismatch` (= CLI exit 75 と整合)。fast-path の 409 とは event body 上区別する (`{ code: "active_task" }` vs `{ code: "lock_host_mismatch" }`)
- process crash 後は既存 `resume` に寄せる (本書 §1.2 の lock stale 回収後に再取得可)

## 2. Dashboard UI (Phase 2B、別 issue)

採用根拠: Phase 2A の curl/jq では plan / review findings / git diff の構造化表示やリアルタイム log tail が辛い。MVP UI を Ink TUI 拡張で済ませる選択肢も併記する。

### 2.1 候補

| 案 | 実装 | assets-hygiene gate との整合 |
|---|---|---|
| 軽量案 | Ink TUI 拡張 (`packages/tui` 拡張) | 容易 (CLI bin 内で完結) |
| 本格案 | Next.js + shadcn/ui を別パッケージ (`packages/dashboard/`) に | `bun build` 静的成果物として配信、API は Phase 2A に依存。`workspace:` / unresolved import 禁止に抵触しない構成を別 issue で詰める |

### 2.2 表示項目 (本格案)

- task 一覧
- phase timeline (audit kind 列)
- provider / model / effort / `resolved_effort` (`tasks.yaml.runtime.resolved_effort`、`phase1-core-cli-runner.md` §4.2)
- `review_round` / `ci_fix_round`
- plan viewer / review findings viewer / git diff viewer
- log tail (SSE)
- run / resume / retry / cleanup ボタン (bearer token 付与)

## 将来拡張 / 残課題

- Phase 2B Dashboard 採用案 (Ink 拡張 vs Next.js 別パッケージ) は Phase 2B issue で確定 (本書 §2.1)
- WebSocket / GraphQL subscription への移行: Phase 3+ 検討
- Unix domain socket bind の運用検証: Phase 2A 実装後の運用フェーズで検証 (本書 §1.3)
