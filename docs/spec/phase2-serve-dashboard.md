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
- [ ] 不正 Origin / Host / Content-Type を 403 / 415 で拒否する E2E (Host: `localhost.` / `LOCALHOST` / `[::1]` / Origin 欠落 / Origin 不一致 を網羅、本書 §1.3 AC)
- [ ] `POST /api/run` 中に同 repo で `autokit run` を起動すると exit 75 + 「serve がロック中」案内 (`failure.code` 発火なし、本書 §1.2 / §1.5)
- [ ] `tasks.yaml` の cross-process 並行書込が `flock(2)` で直列化される
- [ ] `GET /api/events` の SSE が p95 < 1s で push され、生 stdout が漏れない (sanitize 済み event のみ、本書 §1.4.2 redact 必須対象すべて適用)
- [ ] `GET /api/tasks/:issue/diff` が credentials 含む hunk をプレースホルダ化 (`phase1-core-cli-runner.md` §9.2 と同等)
- [ ] bearer token が CSPRNG 生成 / 毎起動 regenerate / `crypto.timingSafeEqual` 比較 / shutdown で unlink される (本書 §1.3 AC)
- [ ] SSE event の bearer / credentials / API key 値 redact / `Last-Event-ID` replay / heartbeat の各 fixture 検証 (本書 §1.4 AC)

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
| 取得失敗時 mapping | HTTP `409 Conflict` (event body `{ code: "serve_lock_busy" }`) ↔ CLI `exit 75 (TEMPFAIL)` + 案内メッセージのみ (`failure.code` は **発火しない**、SPEC §4.2.1.1 既存 `lock_host_mismatch` の「(起動拒否)」「`--force-unlock` 確認」セマンティクスと衝突しないよう、serve 経路は `tasks.yaml` を一切書かない fast-path 統一)  |
| holder 情報 | `.autokit/.lock` に PID / host / acquired_at を記録 |
| stale 検出 | 既存 `.autokit/lock` (SPEC §4.3.1) と同様の lstart / pid 死活確認で自動回収 |

`POST /api/run` 中に同 repo で `autokit run` を実行すると exit 75 + 「serve がロック中」ガイダンスを表示。serve 経路の HTTP 409 は **`tasks.yaml.failure` を書かず audit log + HTTP body のみ** で完結する fast-path とし、CLI 経路の `failure.code=lock_host_mismatch` (= SPEC §4.2.1.1 既存「起動拒否 / exit 1 / `--force-unlock` 経路」) との二重定義を避ける。

### 1.3 認可 / CSRF / DNS rebinding 対策

mutating endpoint と SSE は core の git/gh push / 自動 merge / branch 削除を直接トリガーする。最低限以下を必須:

| 観点 | 仕様 |
|---|---|
| **bind** | 既定 `127.0.0.1` (IPv4) または Unix domain socket (mode `0600`、parent dir `0700`)。`0.0.0.0` / `::` は config で明示 opt-in しても **fail** (warn でなく 起動拒否) |
| **bearer token 生成** | `crypto.randomBytes(32)` で 32 byte CSPRNG → base64url エンコード。**毎 serve 起動で必ず regenerate** (前回トークン再利用禁止)。前回トークン提示は 401 を返す E2E 必須 |
| **bearer token 保存** | ファイル `${XDG_STATE_HOME:-~/.local/state}/autokit/serve.token` mode `0600`、parent dir `${XDG_STATE_HOME:-~/.local/state}/autokit/` mode `0700`。CLI / Dashboard は同ファイル読込で共有 |
| **bearer token 提示** | `Authorization: Bearer <token>` ヘッダのみ受理。query string / cookie / form field 経由は **401** (referrer / browser cache 経由の token leak 防止) |
| **bearer token 比較** | `crypto.timingSafeEqual` (定数時間比較) のみ。`===` / `Buffer.compare` 直接比較禁止 |
| **bearer token 廃棄** | shutdown signal (SIGTERM / SIGINT) ハンドラで token file を `unlink` 後に終了。異常終了時の stale token は次回起動時に上書きで無効化 |
| **bearer token スコープ** | 1 token で `/api/run` / `cleanup` / SSE 全権 (v0.2.0 では分離なし、`cross-cutting.md` 「将来拡張」参照) |
| **Host header** | allowlist は `127.0.0.1:<PORT>` / `localhost:<PORT>` / `[::1]:<PORT>` の **case-insensitive 完全一致**。trailing dot (`localhost.:<PORT>`) は正規化後比較で許可、prefix match / 部分一致禁止。allowlist 外は 403 (DNS rebinding 対策) |
| **Origin** | header 提示時は `same-origin` ホワイトリスト必須、不一致は 403。**header 欠落** は CLI / 直接 curl 経路として許可 (browser fetch は必ず Origin を付与する仕様) |
| **`Sec-Fetch-Site`** | `same-origin` 推奨だが advisory として扱い hard gate にしない (古い browser / 非 fetch 経路で欠落するため。Origin / Host で十分な防御を実現済み) |
| **Content-Type** | mutating endpoint は `application/json` 必須。`application/x-www-form-urlencoded` / `multipart/form-data` / `text/plain` は 415 で拒否 (simple form CSRF 防止) |
| **`/api/events` (SSE)** | bearer + Host + Origin (本書 §1.4)。同時接続数上限は **既定 8** (config `serve.sse.max_connections` で上書き可、超過は 503) |
| **404 / 401 切り分け** | 未認可リクエストが 401 で拒否される E2E を実装。資源不存在の 404 と secret 由来 401 は body / status code で区別可能 |

#### AC 追加 (Phase 2A 完了条件、本書冒頭にも反映)

- [ ] 前回 serve 終了時に保存された token を提示すると 401 を返す
- [ ] `Authorization: Bearer` 以外 (query / cookie / form) の token 提示は 401
- [ ] `Host: localhost.:<PORT>` (trailing dot) / `Host: LOCALHOST:<PORT>` / `Host: [::1]:<PORT>` / `Origin: null` (= header 欠落、CLI 経路) の各 E2E が期待通り 200 / 403 を返す
- [ ] shutdown signal で token file が unlink される
- [ ] token 比較が `crypto.timingSafeEqual` で実装されている (lint / unit test で `===` 禁止を強制)

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

#### 1.4.2 redact 必須対象

logs / events は logger 出力後の sanitize 済み event のみ配信。生 stdout 直結禁止 (SPEC §10.2 既存 `sanitizeLogString` を経由)。SSE 出力前に **以下が必ず** `<REDACTED>` 化されていること:

- bearer token 値 (本書 §1.3)
- `~/.codex/auth.json` / `$CODEX_HOME/auth.json` の値 (CLAUDE.md 「Authentication and secrets」/ SPEC §11.1)
- `~/.claude/credentials*` の値 (同)
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` の値 (CLAUDE.md / SPEC §11.1)
- prompt_contract `data` payload (構造化 field 含めて) は SSE 出力前に同 redactor (`sanitizeLogString` + `phase1-core-cli-runner.md` §9.1 二重 redact) を **必ず通す**
- diff は `phase1-core-cli-runner.md` §9.2 の blacklist hunk 除去後を配信

レスポンスヘッダ: `Content-Type: text/event-stream; charset=utf-8` + `X-Content-Type-Options: nosniff` + `Cache-Control: no-cache, no-transform`。

#### 1.4.3 disconnect / reconnect / Last-Event-ID

- 各 event に **`id:` field を付与** (monotonic ULID 推奨)
- client が `Last-Event-ID: <id>` ヘッダ付きで再接続した場合、server は **直近 N=64 event のリングバッファ** から欠損分を replay (古すぎる場合は `error` event で client に full reload を促す)
- push 失敗 (writable buffer 満杯) は drop でなく `503` 切断 + 再接続待ち (silent drop 禁止)

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
- 本書 §1.2 の cross-process lock 取得失敗 (`flock(2)` 競合) も同様の **fast-path 409** (event body `{ code: "serve_lock_busy" }`、`tasks.yaml` 不書込 / `failure.code` 不発火)。SPEC §4.2.1.1 既存 `lock_host_mismatch` (起動拒否 / exit 1 / `--force-unlock` 経路) との二重定義を避けるため、serve 経路は `failure.code` 不発火で統一
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
