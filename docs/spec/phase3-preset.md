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

`init.backup_blacklist` (default: `.claude/credentials*` / `.codex/auth*` / `.claude/state` / `.claude/sessions` / `.codex/credentials*`、SPEC §4.1 既存) は両経路で共有。

**`init.backup.retention_days` は本 Phase で新規追加** (現 `config.ts:171-180` `init` block には未定義、`logging.retention_days` (config.ts:165) とは別フィールド)。両経路で共通適用、default `30`。SPEC §4.1 への追加は実装 PR (`cross-cutting.md` §5 step 12 の preset 実装と同 PR) で行う責務。

実装メモ: 既存 `init` の copy ロジック (`packages/cli/src/init.ts:73-163` / rollback `init.ts:443-459`) を `assets-writer.ts` 経由で共通化し、`backup_dir` 引数の差し替えのみで両経路に対応する。

### 3.1 Path traversal / blacklist 防御

#### 3.1.1 Path traversal

archive エントリ毎に以下を fail-closed `failure.code=preset_path_traversal`:

- 絶対パス (POSIX `/...` / Windows `C:\...` / drive-letter)
- 親ディレクトリ参照 (`..` / `..\\` / Unicode 相当)
- symlink エントリ (archive 上の symlink type / 解決後 path どちらも禁止)
- NUL byte (`\0`) 含む path
- archive entry path / 出力先 destination の **両方を realpath 解決** し `.agents/` 配下に閉じることを assert
- **親 chain realpath 検査**: `<repo>/.agents/` 自体が symlink でないこと、parent chain (`<repo>/`) も含めて chained-openat (SPEC §11.2.2) で検査。`.agents/` 自体が symlink で repo 外を指している環境では fail-closed

#### 3.1.2 Blacklist (deny-list)

apply / export 両方で必須。**ヒット時 `failure.code=preset_blacklist_hit` で fail-closed**。

| 種別 | 対象 |
|---|---|
| パターン (basename + フルパス両方検査) | `.env*` / `.codex/**` / `.claude/credentials*` / `id_rsa*` / `*.pem` / `*.key` |
| コンテンツ署名 | `BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY` / `ssh-rsa AAAA[A-Za-z0-9+/]{20,}` / `ghp_[A-Za-z0-9]{20,}` / `sk-[A-Za-z0-9]{20,}` / `xox[baprs]-[A-Za-z0-9-]+` / GCP private_key JSON 等 (SPEC §4.6.2.2 token-like pattern と同集合) |

#### 3.1.3 glob 方言

- ライブラリ: `minimatch` 互換、option `{ dot: true, nocase: process.platform === 'darwin' }` (macOS APFS case-insensitive 対応で `.ENV` / `.Env` を捕捉)
- archive entry path と destination realpath の **両方** を上記 option で照合
- Linux ext4 / btrfs では case-sensitive 既定だが、glob option は darwin 検出で自動 toggle (Linux 上の disk image を mount した case-insensitive volume での bypass を防止)

#### AC 追加

- [ ] case-folded `.ENV` / `.Env` を含む preset の apply が `failure.code=preset_blacklist_hit`
- [ ] `prompts/notes.md` 名で SSH PRIVATE KEY を内包する preset の apply がコンテンツ署名検出で fail-closed
- [ ] `.agents/` 親が repo 外 symlink の環境で preset apply が `failure.code=preset_path_traversal`
- [ ] NUL byte 含む archive entry が fail-closed

### 3.2 Atomic apply

- staging directory に展開 → 整合検証 → atomic rename (`.agents/` 全体差し替え)
- 失敗時 staging 破棄。`.agents/` は apply 前と byte 単位一致 (SHA256 manifest で復元可能)
- doctor 失敗時の rollback or paused 状態への遷移を実装

### 3.3 Backup 配置

- backup 先: `${XDG_STATE_HOME:-~/.local/state}/autokit/backup/<repo-id>/<timestamp>/` (mode `0700`)
- `<repo-id>` の確定形式: `sha256(realpath(repoRoot)).slice(0, 16)` (16 hex chars) — basename collision で別 repo の backup が交差するのを防止
- 親 chain mode 強制:
  - `${XDG_STATE_HOME:-~/.local/state}/` … (XDG 既存 mode)
  - `${XDG_STATE_HOME:-~/.local/state}/autokit/` … `0700`
  - `${XDG_STATE_HOME:-~/.local/state}/autokit/backup/` … `0700`
  - `${XDG_STATE_HOME:-~/.local/state}/autokit/backup/<repo-id>/` … `0700`
  - `${XDG_STATE_HOME:-~/.local/state}/autokit/backup/<repo-id>/<timestamp>/` … `0700`
- repo tree 内 (例: `.agents/.backup/`) には作らない
  - `scripts/check-assets-hygiene.sh` の禁止 glob を素通りするのを防止 (SPEC §11.6)
  - 現 `init.backup_dir=.autokit/.backup/<timestamp>/` (SPEC §4.1) は **repo tree 内に残るが既に `assets-hygiene` 禁止 glob (`.claude/*` 等) 対象外**。preset apply の backup のみ repo tree 外へ移動する規約とする
- **backup ソース側にも `init.backup_blacklist` 適用**: `.agents/` 内に紛れ込んだ `.env` / `.claude/credentials*` 等は backup 取得時点で除外、XDG dir に流出させない
- retention は `init.backup.retention_days` 適用 (default `30`、本書 §3 冒頭で新規追加宣言)
- retention 削除失敗 (例: file system 権限欠落 / disk full) は **fail-closed**: silent skip 禁止、apply 自体を `paused` 風 abort + audit log

#### AC 追加

- [ ] 同 basename / 異なる realpath の 2 repo で backup が交差しない (`<repo-id>` 衝突回避)
- [ ] 親 chain (`autokit/` / `backup/` / `<repo-id>/` / `<timestamp>/`) が **mode 0700** で生成される
- [ ] `.agents/` 内に `.env` を含む状態で preset apply 後、XDG backup tree に `.env` が含まれない (backup ソース側 blacklist)
- [ ] retention 削除失敗時に preset apply が fail-closed する

### 3.4 Merge patch 規則

`config.yaml` merge:

- **object**: deep merge
- **array (一般)**: preset 値で完全置換 (例: `label_filter` / `allowed_tools` はユーザー側上書き想定が強いため確実な置換)
- 明示 `null`: default 復帰
- `prompts/` / `skills/` / `agents/` のファイルは **ファイル単位置換 + backup**。部分 merge しない

#### 3.4.1 Protected array (preset 単独で減らせない安全関連 array)

以下の array は **preset 単独で完全置換できない** (silent な防御無効化を防止):

| field | 防御責務 | merge ポリシー |
|---|---|---|
| `logging.redact_patterns` | log redaction (SPEC §4.6.2.2 + §10.2 既存) | **baseline + preset の union** のみ。preset 単独で短くできない (要素削除には `--allow-protected-replace` flag 必須) |
| `init.backup_blacklist` | credentials backup 流出防止 (SPEC §11.5 + 本書 §3.1.2) | union のみ (同上) |
| `permissions.claude.denied_tools` (Phase 1 新設、`phase1-core-cli-runner.md` §1) | 危険 tool 拒否 | union のみ (同上) |

`autokit preset show <name>` は **protected array の diff を強調表示** (実装 PR で TUI marker 追加責務)。`autokit preset apply <name>` は protected array の **完全置換 / 要素削減** を含む preset を `--allow-protected-replace` flag なしで **fail-closed** とする。

#### AC 追加

- [ ] `redact_patterns: []` を含む preset の apply が flag なしで **fail-closed** (`failure.code=preset_blacklist_hit` 経由 or 専用エラー)
- [ ] `init.backup_blacklist` を空にする preset の apply が flag なしで fail-closed
- [ ] `denied_tools` を縮小する preset の apply が flag なしで fail-closed
- [ ] `preset show` 出力で protected array の diff が強調表示される

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
