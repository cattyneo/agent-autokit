# Phase 2: Local API server + Dashboard

## ステータス

- バージョン: v0.2.0+ (Phase 2)
- 関連: `docs/references/agent-autokit_phase1-3_implementation_plan.md` §「Phase 2: Local API server + Dashboard (issue 分割)」
- 既存 SPEC との関係 (引用のみ、改変なし):
  - `../SPEC.md#43-autokitlock` (`.autokit/lock` 単プロセス前提) — 本 Phase で cross-process lock を別 path `.autokit/.lock/` で追加
  - `../SPEC.md#1022-audit-イベント` (新規 操作系 audit kind `serve_lock_busy` を `cross-cutting.md` §2.1 経由で同 PR 追記。既存の `lock_seized` / `auto_merge_disabled` 等は流用)
  - `../SPEC.md#116-assets-hygiene-ci` (`packages/serve/` 追加でも CLI bin self-contained 維持)
  - `../SPEC.md#4211-failurecode-固定列挙` (`lock_host_mismatch` は CLI 経路のみ。serve 経路は fast-path 409 で `failure.code` 不発火)
- 関連 issue / PR: TBD (Phase 2A / Phase 2B を別 issue として分割)

Phase 2 は以下 2 issue に分割。v0.2.0 release gate は **Phase 2A のみ必須**。Phase 2B Dashboard UI は scope 外の skeleton であり、v0.2.0 release-ready 判定に含めない。

- **Phase 2A**: `autokit serve` (HTTP/JSON only) + cross-process lock + auth
- **Phase 2B**: Dashboard UI (Next.js + shadcn/ui or 軽量代替)

## 観測可能な完了条件 (AC)

### Phase 2A 完了条件 (MVP 必須)

- [ ] `autokit serve` が `127.0.0.1` bind で起動し、bearer token なしの mutating request を 401 で拒否
- [ ] Host / Origin / Content-Type matrix が本書 §1.3 と一致する E2E: `localhost.` / `LOCALHOST` / `[::1]` / Origin 欠落は正規化後 200、allowlist 外 Host / Origin 不一致は 403、Content-Type 違反は 415。既定 bind は IPv4 `127.0.0.1` のため、`[::1]` fixture は IPv4 loopback 接続に forged `Host: [::1]:<PORT>` を付ける Host 正規化テストとして扱う
- [ ] `POST /api/run` 中に同 repo で `autokit run` を起動すると exit 75 + 「serve がロック中」案内 (`failure.code` 発火なし、本書 §1.2 / §1.5)
- [ ] `autokit run` 中の `POST /api/run` が 409 になり、`tasks.yaml` が変化しない (`preset apply` との排他は Phase 3 の `preset apply` 実装 owner で検証)
- [ ] A lock 保持、B bounded wait、C 後発起動の 3 プロセス fixture で `.autokit/.lock` の split-brain が起きない
- [ ] `tasks.yaml` の cross-process 並行書込が Node 標準 API の atomic directory lock で直列化される
- [ ] `GET /api/events` の SSE が p95 < 1s で push され、生 stdout が漏れない (sanitize 済み event のみ、本書 §1.4.2 redact 必須対象すべて適用)
- [ ] `GET /api/tasks/:issue/diff` が credentials 含む hunk をプレースホルダ化 + 非ブラックリスト path の token-like content も `<REDACTED>` 化 (`phase1-core-cli-runner.md` §9.2 と同等、path + content の 2 段 redact)
- [ ] bearer token が CSPRNG 生成 / 毎起動 regenerate / `crypto.timingSafeEqual` 比較 / shutdown で unlink される (本書 §1.3 AC)
- [ ] `Authorization: Bearer` 以外 (query / cookie / form) の token 提示が 401 になり、2 repo / 2 port の token path が衝突しない
- [ ] `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` set 状態の mutating endpoint が runner dispatch 前に fail-closed
- [ ] `serve.lock.host_redact` / `serve.sse.max_connections` / `serve.sse.heartbeat_ms` の config default + override fixture が緑
- [ ] read endpoint も bearer + Host gate を必須にし、Origin `null` literal は 403、Origin 欠落は 200 になる
- [ ] SSE event の bearer / credentials / API key / prompt_contract data redact / `Last-Event-ID` replay / heartbeat の各 fixture 検証 (本書 §1.4 AC)
- [ ] `.autokit/.lock/` directory が **mode 0700**、`.autokit/.lock/holder.json` が **mode 0600** で生成される (本書 §1.2)
- [ ] kill-after-mkdir-before-holder fixture で missing / corrupt `holder.json` を incomplete lock として回収でき、repo が永久 lock されない
- [ ] `autokit init` が `.autokit/.gitignore` を生成し、doctor が欠落時 FAIL する (本書 §1.2)
- [ ] `.autokit/.lock` の `host` field に hostname 短縮形のみ記録され、username / FQDN / IP が含まれない fixture 検証 (本書 §1.2)

### Phase 2B 完了条件 (UI、別 issue)

- [ ] Dashboard から状態確認・run/resume/retry/cleanup を実行できる
- [ ] plan / review / diff を画面で確認できる
- [ ] CLI 単体運用と Dashboard 運用が同じ state を共有 (Phase 2A の lock + API 経由)

## 1. `autokit serve` (Phase 2A)

CLI runtime を利用するローカル API server。`packages/serve/` を新設し、installed CLI (`#!/usr/bin/env node` / `node packages/cli/dist/bin.js`) で動作する Node-compatible server (`node:http` ベース、または Hono Node adapter 等) を採用する。`Bun.serve` 依存は禁止。`packages/serve` は source package として分離してもよいが、private distribution の `packages/cli/dist/bin.js` には serve 実行に必要な runtime code を self-contained に bundle し、installed tarball で unresolved workspace import を残さない。Next.js / Dashboard runtime は CLI bin に含めない。

### 1.1 API + endpoint auth matrix

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

mutating endpoint = `POST /api/{run,resume,retry,cleanup}`。SSE = `GET /api/events`。read endpoint も repo state / log / review / diff を返すため **bearer + Host gate を必須** とする (multi-user macOS / 同ホスト別プロセスからの非認可 read 防止)。

| route | bearer | Host allowlist | Origin | Content-Type | 401/403 fixture |
|---|---|---|---|---|---|
| `GET /api/tasks` | 必須 | 必須 | 提示時 same-origin (本書 §1.3) | n/a (no body) | bearer 欠落 401 / Host 違反 403 |
| `GET /api/tasks/:issue` | 必須 | 必須 | 同上 | n/a | 同上 |
| `GET /api/tasks/:issue/plan` | 必須 | 必須 | 同上 | n/a | 同上 |
| `GET /api/tasks/:issue/reviews` | 必須 | 必須 | 同上 | n/a | 同上 |
| `GET /api/tasks/:issue/logs` | 必須 | 必須 | 同上 | n/a | 同上 |
| `GET /api/tasks/:issue/diff` | 必須 | 必須 | 同上 | n/a | 同上 |
| `POST /api/run` | 必須 | 必須 | 同上 | `application/json` 必須 (415 reject) | bearer 欠落 401 / Host 違反 403 / Content-Type 違反 415 |
| `POST /api/resume` | 同上 | 同上 | 同上 | 同上 | 同上 |
| `POST /api/retry` | 同上 | 同上 | 同上 | 同上 | 同上 |
| `POST /api/cleanup` | 同上 | 同上 | 同上 | 同上 | 同上 |
| `GET /api/events` (SSE) | 必須 | 必須 | 同上 | n/a (response: `text/event-stream`) | bearer 欠落 401 / Host 違反 403 / 同時接続上限 503 |

未認可 (401) と資源不存在 (404) は status code で区別可能、resource oracle 化を防ぐため **bearer 検証は path resolution より先に評価する** (path validation 由来の 404 を 401 で吸収)。

#### 1.1.1 Request / response payload contract

全 JSON response は `Content-Type: application/json; charset=utf-8` とし、成功時は `{ "ok": true, ... }`、失敗時は `{ "ok": false, "code": "<stable_code>", "message": "<fixed_or_redacted_message>", "request_id": "<id>" }` を返す。`message` は固定文または redactor 通過後の文言のみ。

| route | request body | success response | error shape / status |
|---|---|---|---|
| `GET /api/tasks` | n/a | `{ ok: true, tasks: TaskSummary[] }` | 401 / 403 |
| `GET /api/tasks/:issue` | n/a | `{ ok: true, task: TaskDetail }` | 401 / 403 / 404 |
| `GET /api/tasks/:issue/plan` | n/a | `{ ok: true, issue, markdown }` | 401 / 403 / 404 |
| `GET /api/tasks/:issue/reviews` | n/a | `{ ok: true, issue, reviews: ReviewSummary[] }` | 401 / 403 / 404 |
| `GET /api/tasks/:issue/logs` | query `{ tail_lines?: number, cursor?: string, max_bytes?: number }` | `{ ok: true, issue, logs, truncated: boolean, next_cursor?: string }` (sanitize 済み) | 401 / 403 / 404 / 413 |
| `GET /api/tasks/:issue/diff` | query `{ cursor?: string, max_bytes?: number }` | `{ ok: true, issue, diff, truncated: boolean, next_cursor?: string }` (2 段 redact 済み) | 401 / 403 / 404 / 413 |
| `POST /api/run` | `{ issue?: number, phase?: Phase, provider?: Provider, effort?: EffortLevel, idempotency_key?: string }` | `{ ok: true, accepted: true, run_id }` | 401 / 403 / 409 / 415 |
| `POST /api/resume` | `{ issue?: number, idempotency_key?: string }` | `{ ok: true, accepted: true, run_id }` | 401 / 403 / 409 / 415 |
| `POST /api/retry` | `{ issue: number, idempotency_key?: string }` | `{ ok: true, accepted: true, run_id }` | 401 / 403 / 409 / 415 |
| `POST /api/cleanup` | `{ issue?: number, merged_only?: boolean }` | `{ ok: true, cleaned: number }` | 401 / 403 / 409 / 415 |
| `GET /api/events` | n/a | SSE frames (本書 §1.4.1) | 401 / 403 / 503 |

`POST` body は unknown key を reject する strict schema。`issue` は正整数、`phase` / `provider` / `effort` は Phase 1 の core 型を使う。`idempotency_key` は任意の printable ASCII 1〜128 文字。`run` / `resume` / `retry` は workflow dispatch request として `202 Accepted` 相当の `{ accepted: true }` を返し、同期完了を待たない。logs / diff の `max_bytes` は server default と hard maximum を持ち、上限超過時は `truncated=true` + `next_cursor` で返す。client 指定が hard maximum を超える場合は 413。

#### 1.1.2 Background run coordinator

`POST /api/run|resume|retry` の `accepted=true` は durable boundary を持つ:

1. request schema / auth / production preflight を通過
2. `idempotency_key` がある場合は repo-local run index を先に lookup する。同じ key の `accepted|running|completed|failed|paused|interrupted` record が存在すれば lock を再取得せず同じ `run_id` と現在 status を返す
3. 新規 request の場合のみ `tryAcquireRunLock(repo)` を取得する。key なし retry は active run があれば 409、完了済みなら latest run status を返す
4. `${XDG_STATE_HOME:-~/.local/state}/autokit/runs/<repo-id>/<run_id>.json` (mode 0600、parent 0700) に `{ run_id, repo_id, operation, issue?, idempotency_key?, status: "accepted", accepted_at }` を fsync 可能な atomic write で永続化
5. background coordinator が workflow を開始できる状態になった後で HTTP `202` を返す

lock lifetime:

- coordinator は workflow 完了 / failed / paused / interrupted / cleanup 完了まで lock を保持し、workflow の最終 checkpoint と run record status (`completed` / `failed` / `paused` / `interrupted`) を書いた後に release する
- serve process crash 時は lock stale 回収後、run record と `tasks.yaml` checkpoint を照合する。`status=accepted|running` で最終 checkpoint がない場合は client に `resume_required` を返し、同じ issue の再 `run` は二重実行せず 409 または既存 `run_id` を返す
- `idempotency_key` が同じ request は、元 run が lock を保持中でも `serve_lock_busy` を返さず同じ `run_id` を返す。key なしの client retry は active run があれば 409、完了済みなら latest run status を返す
- `cleanup` は短時間同期実行または coordinator 経由のどちらでもよいが、実装 PR で選んだ方式を payload schema と E2E に固定する

### 1.2 Cross-process lock と排他制御

`tasks.yaml` の atomic write (SPEC §4.2 / `.autokit/lock`) は単プロセス OS rename のみ前提。serve 常駐後の **CLI 直叩き ↔ HTTP API ↔ 将来の Dashboard click** の三者間排他を新設:

| 項目 | 仕様 |
|---|---|
| 実装 | `packages/core/src/process-lock.ts` (新設) |
| ファイル | `.autokit/.lock/` directory (既存 `.autokit/lock` (SPEC §4.3) とは別 path) |
| 機構 | Node 標準 API の atomic `fs.mkdir(".autokit/.lock")` ベース。native dependency / external `flock` binary は使わない |
| 取得 API | `tryAcquireRunLock(repo)` (fast-fail) / `waitAcquireRunLock(repo, { timeout_ms })` (内部 coordination / race fixture 用) |
| 取得失敗時 mapping | API / CLI は **必ず `tryAcquireRunLock` を使う fast-fail**。HTTP `409 Conflict` + body `{ code: "serve_lock_busy" }` + 操作系 audit kind `serve_lock_busy` (`cross-cutting.md` §2.1 で定義)。CLI 同 repo 直叩きは exit 75 (TEMPFAIL) + 案内メッセージのみ。**`failure.code` 不発火 / `tasks.yaml` 不書込**。SPEC §4.2.1.1 既存 `lock_host_mismatch` (= CLI 起動拒否 / exit 1 / `--force-unlock` 経路) とは別契約 |
| holder 情報 | `.autokit/.lock/holder.json` に opaque `holder_token` / PID / `started_at_lstart` / host / acquired_at / run_id? を記録。`holder_token` は lock owner の release / stale recovery 照合専用で、audit / SSE / stderr / log には出力しない |
| mode | `.autokit/.lock/` は `0700`、`holder.json` は `0600` (multi-user macOS の info-disclosure 遮断) |
| atomicity 契約 | `mkdir` 成功プロセスだけが holder。取得失敗は `EEXIST`。取得直後に `holder.json.tmp` を書き、同 directory 内 rename で `holder.json` を publish する。解放時は `holder_token` を確認して `holder.json` を削除後 `rmdir(".autokit/.lock")`。wrong-token release / stale recovery は lock を変更せず失敗する。`tryAcquireRunLock` は待たずに失敗を返す。`waitAcquireRunLock` は bounded polling/backoff し、`timeout_ms` 到達で失敗を返す。stale 回収は `holder_token` + pid + `started_at_lstart` 確認後にのみ実行する |
| `.gitignore` 強制 | `autokit init` 時に `.autokit/.gitignore` で `*` パターンを書込 (SPEC §3.2 / §11.5 既存 `.autokit/.gitignore` 規約と統合)、`.autokit/.lock` を含む lock / backup / state 全体が **commit/push されないことを init で強制**。doctor は `.gitignore` 欠落を検出して FAIL |
| host field redaction | `host` には **hostname 短縮形のみ** 記録 (例: `macbook.local`、`os.hostname()` 由来) し、ユーザー名 / FQDN / 内部ドメイン / IP を含めない。`os.userInfo().username` 等の **個人情報は記録しない**。host が redact 必須環境では config `serve.lock.host_redact: true` で sha256 短縮形 (16 hex) に置換可能 |
| incomplete lock 検出 | `.autokit/.lock/` は存在するが `holder.json` が missing / corrupt / schema 不一致の場合、directory mtime が短い grace window 内なら busy として扱う。grace 超過後、lock directory 内に有効 holder がなく `holder.json.tmp` 等の一時ファイル以外を含まない場合のみ incomplete lock として `rmdir` で回収する。回収は sanitized diagnostic に留め、新 failure.code / audit kind は追加しない |
| stale 検出 | 既存 `.autokit/lock` (SPEC §4.3.1) と同様の pid / `started_at_lstart` 死活確認で自動回収。PID 再利用で lstart が不一致の場合は別プロセスとして扱い、live lock を削除しない。回収時は holder.json を audit に redacted 記録し、別 holder が再取得済みなら回収を中止 |

適用範囲:

- Phase 2A 時点で存在する write CLI command (`autokit init` / `add` / `run` / `resume` / `retry` / `cleanup`) は、処理開始前に `tryAcquireRunLock(repo)` を取得する。取得失敗時は待機せず、`tasks.yaml` / worktree / PR checkpoint を更新せず exit `75`
- `autokit preset apply` は Phase 3 で初めて command 本体が実装されるため、Phase 2A gate では要求しない。Phase 3 の `preset apply` 実装時に同じ `tryAcquireRunLock(repo)` を必ず消費し、`.agents` 更新との排他を P3/P3-E2E で検証する
- HTTP mutating endpoint (`POST /api/run` / `resume` / `retry` / `cleanup`) は同じ `tryAcquireRunLock(repo)` を使う。CLI 実行中の API は `409 { code: "serve_lock_busy" }`、API 実行中の CLI は exit `75`
- E2E は双方向を固定する: API 実行中の `autokit run` が exit `75`、CLI 実行中の `POST /api/run` が 409。どちらも `tasks.yaml` の二重 write / PR 二重作成が発生しないことを assert
- 3 プロセス race fixture は `waitAcquireRunLock(repo, { timeout_ms })` または同等の internal test helper で検証する: A が `.autokit/.lock/` を保持、B が bounded wait、C が後発起動しても、A release 直後に B/C が同時取得しないこと。API / CLI の user-facing path はこの待機 API を使わない

### 1.2.1 serve config schema

Phase 2A で `packages/core/src/config.ts` に `serve` schema を追加する:

```yaml
serve:
  lock:
    host_redact: false
  sse:
    max_connections: 8
    heartbeat_ms: 15000
```

`doctor` / config parse fixture は `serve.lock.host_redact`、`serve.sse.max_connections`、`serve.sse.heartbeat_ms` の default と override を検証する。

`POST /api/run` 中に同 repo で `autokit run` を実行すると exit 75 + 「serve がロック中」ガイダンスを表示。serve 経路の HTTP 409 は **`tasks.yaml.failure` を書かず audit log + HTTP body のみ** で完結する fast-path とし、CLI 経路の `failure.code=lock_host_mismatch` (= SPEC §4.2.1.1 既存「起動拒否 / exit 1 / `--force-unlock` 経路」) と契約レベルで分離する。

### 1.3 認可 / CSRF / DNS rebinding 対策

mutating endpoint と SSE は core の git/gh push / 自動 merge / branch 削除を直接トリガーする。最低限以下を必須:

| 観点 | 仕様 |
|---|---|
| **bind** | 既定 `127.0.0.1` (IPv4) または Unix domain socket (mode `0600`、parent dir `0700`)。`0.0.0.0` / `::` は config で明示 opt-in しても **fail** (warn でなく 起動拒否) |
| **bearer token 生成** | `crypto.randomBytes(32)` で 32 byte CSPRNG → base64url エンコード。**毎 serve 起動で必ず regenerate** (前回トークン再利用禁止)。前回トークン提示は 401 を返す E2E 必須 |
| **bearer token 保存** | ファイル `${XDG_STATE_HOME:-~/.local/state}/autokit/serve/<repo-id>/<port>/token` mode `0600`、parent dir `${XDG_STATE_HOME:-~/.local/state}/autokit/serve/<repo-id>/<port>/` mode `0700`。`<repo-id>=sha256(realpath(repoRoot)).slice(0,16)`。CLI / Dashboard は repo root + port から同ファイルを解決して共有 |
| **bearer token 提示** | `Authorization: Bearer <token>` ヘッダのみ受理。query string / cookie / form field 経由は **401** (referrer / browser cache 経由の token leak 防止) |
| **bearer token 比較** | `crypto.timingSafeEqual` (定数時間比較) のみ。`===` / `Buffer.compare` 直接比較禁止 |
| **bearer token 廃棄** | shutdown signal (SIGTERM / SIGINT) ハンドラで該当 repo/port の token file を `unlink` 後に終了。異常終了時の stale token は同 repo/port の次回起動時に上書きで無効化。他 repo/port の token は触らない |
| **bearer token スコープ** | 1 token で `/api/run` / `cleanup` / SSE 全権 (v0.2.0 では分離なし、`cross-cutting.md` 「将来拡張」参照) |
| **Host header** | allowlist は `127.0.0.1:<PORT>` / `localhost:<PORT>` / `[::1]:<PORT>` の **case-insensitive 完全一致**。既定 bind は IPv4 `127.0.0.1` のため、`[::1]` は到達性ではなく Host header 正規化対象として扱う。fixture は IPv4 loopback 接続に forged `Host: [::1]:<PORT>` を付けて 200 を検証する。実 IPv6 loopback listener を追加する場合は別途 `::1` bind smoke を実装 PR で固定する。trailing dot (`localhost.:<PORT>`) は正規化後比較で許可、prefix match / 部分一致禁止。allowlist 外は 403 (DNS rebinding 対策) |
| **Origin** | 4 状態を明示的に区別 (本書 §1.3.1) |
| **`Sec-Fetch-Site`** | `same-origin` 推奨だが advisory として扱い hard gate にしない (古い browser / 非 fetch 経路で欠落するため。Origin / Host で十分な防御を実現済み) |
| **Content-Type** | mutating endpoint は `application/json` 必須。`application/x-www-form-urlencoded` / `multipart/form-data` / `text/plain` は 415 で拒否 (simple form CSRF 防止) |
| **`/api/events` (SSE)** | bearer + Host + Origin (本書 §1.4)。同時接続数上限は **既定 8** (config `serve.sse.max_connections` で上書き可、超過は 503) |

2A.2 の mutating endpoint 実装時点で bearer token の生成 / 保存 / 毎起動 regenerate / reuse rejection / `crypto.timingSafeEqual` 比較 / shutdown unlink までを必須にする。placeholder token や `===` 比較で state-changing endpoint を expose する中間 PR は禁止。2A.3 は Host / Origin / Content-Type matrix と token file mode / umask fixture を hardening する。

mutating endpoint は CLI executor と同じ production preflight を共有する。`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` が set されている場合、`POST /api/run` / `resume` / `retry` / `cleanup` は同じ middleware/helper で runner dispatch 前に fail-closed し、HTTP body は固定エラー (`{ ok: false, code: "api_key_env_forbidden", ... }` 相当) のみを返す。

404 / 401 切り分け: 未認可リクエストが 401 で拒否される E2E を実装。資源不存在の 404 と secret 由来 401 は body / status code で区別可能。

#### 1.3.1 Origin 4 状態の取扱い

`Origin` header の状態は browser-visible で 4 種に分かれる。それぞれ別ステータスを返す:

| 状態 | request での見え方 | 取扱い | 経路想定 |
|---|---|---|---|
| 同一オリジン | `Origin: http://127.0.0.1:<PORT>` / `http://localhost:<PORT>` (case-insensitive、Host allowlist と整合) | **200** (同一オリジン許可) | Dashboard / curl `--header` |
| 異なるオリジン | `Origin: https://evil.example` 等 allowlist 外 | **403** | CSRF / DNS rebinding 試行 |
| 文字列 `null` リテラル | `Origin: null` (sandboxed iframe / `file://` / privacy mode 由来で browser が明示送出) | **403** (browser 経路と推定、明示拒否) | sandboxed iframe / 攻撃 surface |
| header 欠落 | `Origin` が request に存在しない | **200** (CLI / 直接 curl 経路として許可、browser fetch は必ず Origin を付与) | CLI / curl |

**注意**: `Origin: null` リテラルは header 欠落と区別する。browser が明示的に `null` 文字列を送る経路 (sandboxed iframe 等) は攻撃 surface として既知のため fail-closed。CLI / curl で意図的に `Origin: null` を明示送出した場合も 403 (回避するなら header を付けない or 同一オリジンを送る)。

#### AC 追加 (Phase 2A 完了条件、本書冒頭にも反映)

- [ ] 前回 serve 終了時に保存された token を提示すると 401 を返す
- [ ] `Authorization: Bearer` 以外 (query / cookie / form) の token 提示は 401
- [ ] 2 repo / 2 port で同時に serve を起動しても token path が衝突せず、一方の shutdown が他方の token を unlink しない
- [ ] `Host: localhost.:<PORT>` (trailing dot) / `Host: LOCALHOST:<PORT>` / `Host: [::1]:<PORT>` の各 E2E が期待通り 200 を返す
- [ ] Origin 4 状態の各 E2E (同一: 200 / 異なる: 403 / `null` リテラル: 403 / 欠落: 200)
- [ ] shutdown signal で token file が unlink される
- [ ] token 比較が `crypto.timingSafeEqual` で実装されている (lint / unit test で `===` 禁止を強制)
- [ ] read endpoint (`GET /api/tasks/*`) も bearer + Host gate で保護される (本書 §1.1 endpoint auth matrix)

### 1.4 Sanitize / redact 配信 + SSE event schema

#### 1.4.1 SSE event 種別 (closed list)

| kind | 出所 | redact 必須対象 |
|---|---|---|
| `task_state` | tasks.yaml diff 検出時 | (生応答 / 自由入力なし、構造化 field のみ) |
| `phase_started` / `phase_finished` | `transitionTask()` 経由 | (構造化のみ) |
| `audit` | logger.ts 経由 (操作系 + 失敗系 audit kind) | `failure.message` は本書 §1.4.2 全 redactor 通過後 |
| `runner_stdout` (debug level のみ) | runner spawn の tee | 本書 §1.4.2 全 redactor 必須 |
| `heartbeat` | server-driven (本書 §1.4.4) | (payload なし) |
| `error` | server-side error (内部) | message は固定文字列のみ。stack trace 出力禁止 |

未列挙 kind の追加は SPEC §10.2.2 拡張と同 PR で `cross-cutting.md` 命名 mapping にも追記する責務。

SSE frame payload:

| event | data JSON |
|---|---|
| `task_state` | `{ "issue": number, "state": string, "runtime_phase": string, "updated_at": string }` |
| `phase_started` / `phase_finished` | `{ "issue": number, "phase": string, "provider"?: string, "effort"?: string, "at": string }` |
| `audit` | `{ "kind": string, "issue"?: number, "message"?: string, "details"?: object, "at": string }` (redact 済み) |
| `runner_stdout` | `{ "issue": number, "phase": string, "chunk": string, "at": string, "truncated"?: boolean }` (debug + redact 済み) |
| `heartbeat` | `{}` |
| `error` | `{ "code": string, "message": string }` |

各 frame は `id:` と `event:` を必ず持つ。`data` は JSON 1 行で、未 redacted raw stdout / stack trace / token literal を含めない。

#### 1.4.2 redact 必須対象

logs / events は logger 出力後の sanitize 済み event のみ配信。生 stdout 直結禁止 (SPEC §10.2 既存 redaction contract)。SSE 出力前に **Phase 1 で core public API 化済みの redactor** (`sanitizeLogString` + diff redactor) を通し、以下が必ず `<REDACTED>` 化されていること:

- bearer token 値 (本書 §1.3)
- `~/.codex/auth.json` / `$CODEX_HOME/auth.json` の値 (CLAUDE.md 「Authentication and secrets」/ SPEC §11.1)
- `~/.claude/credentials*` の値 (同)
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` の値 (CLAUDE.md / SPEC §11.1)
- prompt_contract `data` payload (構造化 field 含めて) は SSE 出力前に同 redactor (`phase1-core-cli-runner.md` §9.1 public redaction API) を **必ず通す**
- JSON-like な `data` / credential key (`api_key`, `client_secret`, `private_key` 等) を含む stdout 文字列も raw 表示しない
- diff は `phase1-core-cli-runner.md` §9.2 の **2 段 redact** (path-based hunk 除去 + 全 hunk body content redaction) 後を配信

レスポンスヘッダ: `Content-Type: text/event-stream; charset=utf-8` + `X-Content-Type-Options: nosniff` + `Cache-Control: no-cache, no-transform`。

#### 1.4.3 disconnect / reconnect / Last-Event-ID

- 各 event に **`id:` field を付与** (monotonic ULID 推奨)
- redaction 後の 1 frame は 64 KiB 以下に制限する。oversized `runner_stdout` は `chunk` を truncate して `truncated=true` を付与し、なお制限を超える payload は固定文言の `error` event へ置換する
- client が `Last-Event-ID: <id>` ヘッダ付きで再接続した場合、server は **直近 N=64 event のリングバッファ** から欠損分を replay (古すぎる場合は `error` event で client に full reload を促す)
- 接続前の同時接続上限超過は 503。headers 送信後の SSE stream では HTTP status を変更できないため、writable buffer 満杯時は `error` event (`code="backpressure"`) を送れる場合は送ってから close、送れない場合は即 close する。SSE client write 失敗は `sse_write_failed` audit kind で記録し、workflow / mutation の成否には波及させない (silent drop 禁止)

#### 1.4.4 heartbeat

- 既定 **15 秒間隔** で `event: heartbeat\ndata: {}\n\n` を送信
- proxy / NAT による idle timeout 対策。client が 45 秒受信なしで切断 → reconnect ロジックへ
- config `serve.sse.heartbeat_ms` で上書き可

#### AC 追加

- [ ] SSE 出力に bearer token 値 / `~/.codex/auth.json` 内容 / `~/.claude/credentials*` 内容 / `ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY` 値が **fixture 検証で出現しない**
- [ ] prompt_contract `data` payload が redactor を通過してから配信される
- [ ] `Last-Event-ID` 付き再接続で欠損 event が replay される (リングバッファ容量内)
- [ ] heartbeat が config 値どおり送信される

### 1.5 実行制御

- `parallel: 1` を維持 (SPEC §1.3 非ゴール)
- API 操作は内部 workflow を呼ぶ (CLI 経路と同一の core API 経由)
- active task がある場合は 409 で拒否 (**fast-path**、`tasks.yaml` 不書込 / `failure.code` 不発火、event body `{ code: "active_task" }`)
- 本書 §1.2 の cross-process lock 取得失敗 (`mkdir` 競合) も同様の **fast-path 409** (event body `{ code: "serve_lock_busy" }`、`tasks.yaml` 不書込 / `failure.code` 不発火)。SPEC §4.2.1.1 既存 `lock_host_mismatch` (起動拒否 / exit 1 / `--force-unlock` 経路) との二重定義を避けるため、serve 経路は `failure.code` 不発火で統一
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

### 2.3 UX / accessibility AC (起票時に具体化)

- run / resume / retry / cleanup は keyboard 操作だけで実行可能。各 action は accessible name を持ち、disabled / busy / error 状態を視覚表示と screen-reader 向け status で同時に表現する
- mutating action 完了後は発火元または結果領域へ focus を復元し、SSE による状態更新は live region で過剰通知なく伝える
- diff / log viewer は keyboard scroll / copy / selection が可能で、長時間実行中も現在 phase・最終 event・失敗理由が迷子にならない
- P2B 子 Issue では上記を AC とテスト (unit または browser E2E) に落とし、機能実装だけで close しない

## 将来拡張 / 残課題

- Phase 2B Dashboard 採用案 (Ink 拡張 vs Next.js 別パッケージ) は Phase 2B issue で確定 (本書 §2.1)
- WebSocket / GraphQL subscription への移行: Phase 3+ 検討
- Unix domain socket bind の運用検証: Phase 2A 実装後の運用フェーズで検証 (本書 §1.3)
