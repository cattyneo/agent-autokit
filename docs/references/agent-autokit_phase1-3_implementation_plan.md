# agent-autokit Phase 1-3 実装計画

作成日: 2026-05-05

## 目的

`agent-autokit` を、GitHub Issue 起点で plan / implement / review / fix / CI / merge まで進めるローカル実行基盤として実用化する。

重点は次の4つ。

- 任意フェーズで Claude / Codex を切り替える
- フェーズごとに model / effort / prompt / skill を切り替える
- review → supervise → fix の修正ループを安定化する
- CLIを維持しつつ、進捗・ログ・差分を確認しやすくする

## 基本方針

- `core` は state / git / gh / PR / merge / cleanup を単独所有する
- `runner` は Claude / Codex 呼び出し adapter に徹する
- `prompt_contract` の構造化出力 schema は原則維持する
- `.autokit/config.yaml` を設定の SoT にする
- API key env unset、subscription auth、sanitize / redact 方針は維持する
- `tasks.yaml` checkpoint / resume / retry 設計を壊さない

---

## Phase 1: CLI / Core / Runner 安定化

### 1. Provider 自由切替

現在の phase 固定に近い runner 制約を、capability 判定に置き換える。

対象 phase:

```text
plan / plan_verify / plan_fix / implement / review / supervise / fix
```

実装内容:

- `config.phases.<phase>.provider` を実行時に尊重する
- Claude / Codex runner の受理 phase 制約を緩和する
- `phase × provider × permission` の capability table を導入する
- 不正な provider / permission 組み合わせは `doctor` と `run` 開始時に fail-closed
- 安全境界は provider ではなく phase 側で定義する

推奨 permission profile:

| phase | scope | write |
|---|---|---:|
| plan | repo | no |
| plan_verify | repo | no |
| plan_fix | repo | no |
| implement | worktree | yes |
| review | worktree | no |
| supervise | worktree | no |
| fix | worktree | yes |

### 2. Effort 切替

`model` と独立して `effort` を設定できるようにする。

```ts
type EffortLevel = "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
```

設定例:

```yaml
effort:
  default: medium
  unsupported_policy: fail # fail | downgrade

phases:
  plan:
    provider: claude
    model: auto
    effort: high
    prompt_contract: plan

  implement:
    provider: codex
    model: auto
    effort: xhigh
    prompt_contract: implement

  review:
    provider: claude
    model: auto
    effort: high
    prompt_contract: review
```

実装方針:

- Codex は native effort が使える場合、runner 起動時に明示反映する
- Claude は native effort flag を前提にせず、model / max_turns / timeout / prompt policy の組み合わせで autokit effort profile として扱う
- `auto` は provider 既定値を使う
- 未対応 effort は `unsupported_policy` に従う
- 解決後の値を `runtime.resolved_effort` と log に保存する

### 3. Config / Runtime 更新

`packages/core/src/config.ts` と runtime model を拡張する。

追加項目:

- `PhaseConfig.effort`
- `effort.default`
- `effort.unsupported_policy`
- `runtime.resolved_effort`
- provider capability validation
- phase permission validation

維持する制約:

- `prompt_contract` は phase と 1:1
- read-only phase では書き込み不可
- network 設定は既存方針を維持
- provider / model / effort が不明な場合は `doctor` で検出

### 4. Runner 更新

Claude runner:

- read-only phase と write phase の allowed tools を分離
- `implement` / `fix` を Claude に割り当てた場合のみ Edit / Write / Bash を許可
- `review` / `supervise` は read-only を維持
- effort は autokit profile として prompt / model / max_turns / timeout に変換

Codex runner:

- 全 phase を受けられるように prompt_contract schema を共通化
- read-only phase は sandbox read-only
- write phase は workspace-write
- effort は native 設定として runner 起動時に渡す
- session resume / JSONL parse は既存設計を維持

### 5. Review / Fix ループ安定化

対象ループ:

```text
review → supervise → fix → review
ci_wait → fix → ci_wait
```

実装内容:

- `review.max_rounds` / `ci.fix_max_rounds` をE2Eで固定
- `finding_id` の同一性判定を維持
- supervisor の accept / reject 不整合を prompt_contract violation として扱う
- prompt_contract violation は1回だけ self-correction retry を許可
- review artifact と fix input の対応を log に残す

### 6. CLI 追加

追加コマンド案:

```bash
autokit config show
autokit config validate
autokit phase matrix
autokit logs --issue <n>
autokit diff --issue <n>
```

一時 override 案:

```bash
autokit run --phase <phase> --provider <claude|codex> --effort <level>
```

永続設定は `.autokit/config.yaml` に集約する。

### Phase 1 完了条件

- default provider split で E2E が完走する
- 任意 phase の provider を config で変更できる
- effort を phase ごとに設定できる
- invalid provider / effort / permission を `doctor` で検出できる
- review-fix loop と CI-fix loop の停止理由が明確に記録される
- `run / resume / retry / cleanup` の後方互換を保つ

---

## Phase 2: Local Dashboard

### 1. `autokit serve`

CLI runtime を利用するローカルAPI serverを追加する。

役割:

- `tasks.yaml` 読み取り
- plan / review / logs / diff 読み取り
- `run / resume / retry / cleanup` 起動
- 実行中 log の stream
- failure.code と復旧導線の表示

API案:

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
GET  /api/events
```

### 2. UI

Next.js + shadcn/ui を想定する。

表示項目:

- task 一覧
- phase timeline
- provider / model / effort
- review_round / ci_fix_round
- plan viewer
- review findings viewer
- git diff viewer
- log tail
- run / resume / retry / cleanup ボタン

### 3. 実行制御

- `parallel: 1` を維持
- UI操作は内部 workflow を呼ぶ
- active task がある場合は二重起動を拒否
- process crash 後は既存 `resume` に寄せる

### Phase 2 完了条件

- Dashboard から状態確認できる
- Dashboard から `run / resume / retry / cleanup` を実行できる
- 実行中 log がリアルタイムに見える
- plan / review / diff を画面で確認できる
- CLI単体運用とDashboard運用が同じ state を共有する

---

## Phase 3: Prompt / Skill Pack

### 1. Preset 構造

工程ごとの prompt / skill / provider / effort をまとめて切り替える preset を導入する。

```text
.autokit/presets/
  default/
    config.yaml
    prompts/
    skills/
    agents/

  laravel-filament/
    config.yaml
    prompts/
    skills/
    agents/

  next-shadcn/
    config.yaml
    prompts/
    skills/
    agents/
```

### 2. Preset Commands

```bash
autokit preset list
autokit preset show <name>
autokit preset apply <name>
autokit preset diff <name>
autokit preset export <name>
```

適用方針:

- `.agents/prompts` / `.agents/skills` / `.agents/agents` に反映
- 既存ファイルは backup してから上書き
- `config.yaml` は merge patch として適用
- `prompt_contract` schema は変更しない
- preset 適用後に `doctor` を自動実行する

### 3. 初期 Preset

| preset | 用途 |
|---|---|
| default | 汎用Issue処理 |
| laravel-filament | Laravel / Filament 実装・レビュー |
| next-shadcn | Next.js / shadcn/ui 実装・UI改善 |
| docs-review | ドキュメント整合性・仕様レビュー |
| teaching | 教材・講座向けコードレビュー |

### Phase 3 完了条件

- preset を一覧・適用・差分確認できる
- preset 適用後も `doctor` が通る
- Laravel / Next.js 用の初期 preset が使える
- prompt / skill 変更による prompt_contract violation をテストで検出できる
- project ごとの `.agents` カスタマイズを安全に維持できる

---

## 実装順序

1. `config.ts` に effort と capability validation を追加
2. `AgentRunInput` に effort / effective permission を追加
3. runner の phase 固定制約を capability 判定へ置換
4. Codex runner の effort 反映を実装
5. Claude runner の effort profile 変換を実装
6. `doctor` に provider / effort / prompt / permission 検証を追加
7. review-fix / ci-fix loop のE2Eテストを追加
8. `autokit serve` を追加
9. Dashboard MVP を追加
10. preset 構造と commands を追加
11. 初期 preset を追加
12. user-guide / dev-guide / SPEC を更新

## 主なリスクと対策

| リスク | 対策 |
|---|---|
| provider自由化で安全境界が曖昧になる | phase permission profile を先に固定する |
| Claude write phase が過剰権限になる | write phase のみ allowed tools を拡張する |
| effort の意味が provider/model によりズレる | native effort と autokit effort profile を分離する |
| prompt カスタムで構造化出力が壊れる | prompt_contract test と self-correction retry を入れる |
| Dashboard と CLI の二重起動 | lock / active task 検出を既存設計に寄せる |
| preset 適用で既存 `.agents` を壊す | backup / diff / doctor を必須化する |

## セルフレビュー

- Phase 1-3 の範囲に絞られている
- provider 自由切替と effort 切替が Phase 1 の必須実装として入っている
- 既存の state machine / prompt_contract / tasks.yaml を壊さない方針になっている
- review-fix loop、CI-fix loop、Prompt/Skill Pack が分離されている
- CLI単体運用とDashboard運用の両立が維持されている
- 安全境界、権限、unsupported effort の扱いが明記されている
