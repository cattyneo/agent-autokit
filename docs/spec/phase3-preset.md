# Phase 3: Prompt / Skill Pack (preset)

## ステータス

- バージョン: v0.2.0+ (Phase 3)
- 関連: `docs/references/agent-autokit_phase1-3_implementation_plan.md` §「Phase 3: Prompt / Skill Pack (preset)」
- 既存 SPEC との関係 (引用のみ、改変なし):
  - `../SPEC.md#115-backup-保管` (`audit-hmac-key` lifecycle / blacklist 判定 realpath + inode、本 Phase の preset apply backup と整合)
  - `../SPEC.md#116-assets-hygiene-ci` (publish 候補禁止 glob、preset backup を repo tree 外に置く根拠)
  - `../SPEC.md#83-同梱-skill-normative-仕様-sot-参照` (`autokit-implement` / `autokit-question` / `autokit-review` skill SoT)
  - `../SPEC.md#943-prompt_contract-ファイル配置` / `../SPEC.md#9-44-11-対応表` (prompt_contract 1:1 制約)
  - `../SPEC.md#4211-failurecode-固定列挙` (新 `failure.code=preset_path_traversal` / `preset_blacklist_hit` を `cross-cutting.md` §1 経由で同 PR 追記)
- 関連 issue / PR: TBD

## 観測可能な完了条件 (AC)

計画書「Phase 3 完了条件 (観測可能)」をそのまま転記。

- [ ] `preset list / show / apply` が動作し、apply 後に `doctor` が緑
- [ ] preset apply 前後で `.agents/**` の SHA256 manifest が backup から復元可能
- [ ] path traversal / blacklist hit が `failure.code=preset_path_traversal` / `preset_blacklist_hit` で fail-closed
- [ ] prompt / skill 変更による `prompt_contract_violation` を `runner-contract.test.ts` で全 phase 検出
- [ ] backup 配置が repo tree 外 (`scripts/check-assets-hygiene.sh` 緑)
- [ ] Laravel / Next.js / docs-create 用の初期 preset が apply 可能で、E2E (fixture repo) が緑

## 1. Preset 構造

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

各 preset は以下 4 サブツリーで構成:

- `config.yaml`: `packages/core/src/config.ts` の zod schema に従う部分 / 全体設定
- `prompts/`: `packages/cli/assets/prompts/` の上書き候補 (phase 別 prompt 自由記述部のみ)
- `skills/`: `autokit-implement` / `autokit-question` / `autokit-review` の上書き候補 (SPEC §8.3)
- `agents/`: `packages/cli/assets/agents/` の上書き候補

## 2. Preset Commands (MVP は 3 verb)

```bash
autokit preset list        # 一覧
autokit preset show <name> # 内容表示
autokit preset apply <name>
```

各 verb 想定ユースケース:

- `list`: 利用可能な preset の確認
- `show`: 適用前の中身把握
- `apply`: project に反映 (backup + atomic + doctor)

### 2.1 audit kind

apply 時に以下の操作系 audit kind を発火 (`cross-cutting.md` §2.1):

- `preset_apply_started` — staging 展開開始時
- `preset_apply_finished` — atomic rename 完了時

## 3. Apply の安全制約

`init` と `preset apply` は **同 API (`packages/core/src/assets-writer.ts` 新設) + `init.backup_blacklist` 共有**。`backup_dir` は経路別に分岐:

| 経路 | backup 配置 | 根拠 |
|---|---|---|
| `autokit init` | `<repo>/.autokit/.backup/<timestamp>/` (SPEC §4.1 既存 `init.backup_dir`) | init 直後 rollback 必須 / repo 内に閉じる必要あり |
| `autokit preset apply` | `${XDG_STATE_HOME:-~/.local/state}/autokit/backup/<repo>/<timestamp>/` (本書 §3.3) | repo tree 外で `scripts/check-assets-hygiene.sh` 禁止 glob を素通りさせない |

`init.backup_blacklist` (default: `.claude/credentials*` / `.codex/auth*` / `.claude/state` / `.claude/sessions` / `.codex/credentials*`) は両経路で共有。`init.backup.retention_days` も両経路で共通適用。

実装メモ: 既存 `init` の copy ロジック (`packages/cli/src/init.ts:73-163` / rollback `init.ts:443-459`) を `assets-writer.ts` 経由で共通化し、`backup_dir` 引数の差し替えのみで両経路に対応する。

### 3.1 Path traversal / blacklist 防御

- preset archive エントリ毎に **絶対パス / `..` / symlink 禁止**:
  - 絶対パス・親ディレクトリ参照・symlink を含むエントリは fail-closed `failure.code=preset_path_traversal`
- 出力先 realpath が `.agents/` 配下に閉じることを assert
- deny-list 必須 (apply / export 両方):
  - `.env*`
  - `.codex/**`
  - `.claude/credentials*`
  - `id_rsa*`
  - `*.pem`
  - `*.key`
  - ヒット時 `failure.code=preset_blacklist_hit` で fail-closed

### 3.2 Atomic apply

- staging directory に展開 → 整合検証 → atomic rename (`.agents/` 全体差し替え)
- 失敗時 staging 破棄。`.agents/` は apply 前と byte 単位一致 (SHA256 manifest で復元可能)
- doctor 失敗時の rollback or paused 状態への遷移を実装

### 3.3 Backup 配置

- backup 先: `${XDG_STATE_HOME:-~/.local/state}/autokit/backup/<repo>/<timestamp>/` (mode `0700`)
- repo tree 内 (例: `.agents/.backup/`) には作らない
  - `scripts/check-assets-hygiene.sh` の禁止 glob を素通りするのを防止 (SPEC §11.6)
  - 現 `init.backup_dir=.autokit/.backup/<timestamp>/` (SPEC §4.1) は **repo tree 内に残るが既に `assets-hygiene` 禁止 glob (`.claude/*` 等) 対象外**。preset apply の backup のみ repo tree 外へ移動する規約とする
- retention は `init.backup.retention_days` (既存 config) 適用

### 3.4 Merge patch 規則

`config.yaml` merge:

- **object**: deep merge
- **array**: preset 値で完全置換 (`label_filter` / `allowed_tools` / `redact_patterns` はユーザー側上書き想定が強いため確実な置換)
- 明示 `null`: default 復帰
- `prompts/` / `skills/` / `agents/` のファイルは **ファイル単位置換 + backup**。部分 merge しない

## 4. 初期 Preset

| preset | 用途 |
|---|---|
| default | 汎用 Issue 処理 |
| laravel-filament | Laravel / Filament 実装・レビュー |
| next-shadcn | Next.js / shadcn/ui 実装・UI 改善 |
| docs-create | ドキュメント作成・整合性レビュー |

注: 各 preset の `prompt_contract` schema は **不変** (SPEC §9.3、`phase4-quality.md` §2 と整合)。phase 別 prompt の自由記述部のみカスタマイズ可。

## 将来拡張 / 残課題

計画書「Phase 3+ で追加検討 (dead alias 化リスク回避のため後置)」をそのまま転記。

- `autokit preset apply --dry-run` (= `diff` の代替で十分か検討)
- `autokit preset export <name>` (受信者・ユースケース未確定のため Phase 3+)
