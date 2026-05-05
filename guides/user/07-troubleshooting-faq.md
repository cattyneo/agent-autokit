# 07. トラブルシューティング & FAQ

> この章で解決すること: よくあるエラーと FAQ をエラーメッセージ・症状から逆引きする。

## エラーメッセージ別

### `ANTHROPIC_API_KEY,OPENAI_API_KEY,CODEX_API_KEY must not be exported`

`autokit run` / `autokit init` の起動時に出る。subscription 認証が API key 認証に上書きされるのを防ぐため。

```bash
unset ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY
```

`.env` などにも書かないこと（`autokit doctor` の `cwd .env` チェックで FAIL する）。

### `existing init backup requires autokit init --force`

過去の `init` が rollback 経由で `.autokit/.backup/<timestamp>/` を残している。

```bash
ls -la .autokit/.backup/
# 中身を確認し、不要なら手動削除
rm -rf .autokit/.backup/
# または、復旧したい意図があるなら個別 cp で復旧
```

意図的に上書き init したいだけなら:

```bash
autokit init --force
```

### `backup blacklist conflict: <pattern>`

認証関連ファイル（`.codex/auth*` 等）が cwd に存在し、`init` がバックアップ対象に含めてしまう恐れがあるため abort。本物の認証ファイルが repo 配下に置かれていないかを必ず確認し、誤って置かれていたら repo 外へ移す。`.gitignore` 漏れの可能性も確認。

### `symlink_invalid: <path>`

`.claude/skills` 等の symlink が `.agents/` 外を指している、または通常ディレクトリになっている。安全のため abort。

```bash
ls -la .claude .codex
# 不正な symlink を削除し、autokit init を再実行
```

### `<file> contains API keys`（doctor の cwd .env）

`.env*` のいずれかに `ANTHROPIC_API_KEY=` 等の行がある。`grep -E '^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY)=' .env*` で特定し削除。

### `prompt contracts: missing=<...> extra=<...>`

`.agents/prompts/` の中身が `DEFAULT_CONFIG` 期待のセットと一致しない。`autokit init --dry-run` で計画上のアセット一覧を確認し、欠落 / 余分を修正。最終手段は `init` をやり直し（既存ファイルがあれば skip 扱いになるので、削除してから `init` 再実行）。

### `issue #N is not paused`

`autokit resume <N>` を打ったが `<N>` は `paused` ではない。`autokit list` で実際の state を確認。`queued` / `merged` / `failed` への対処はそれぞれ `run` / 不要 / `retry`。

### `issue #N must be retried with autokit retry`

`paused` だが `failure.code === retry_cleanup_failed`。`resume` では進められない。

```bash
autokit retry <N>
```

### `issue #N failed force-detach precondition`

`autokit cleanup --force-detach <N>` 実行時に PR が MERGED でない / head SHA が一致しない。`gh pr view <N>` で PR の現状確認。merge 済みでも head SHA が違う場合は誰かが force-push した可能性。手動で merge を完了させてから再試行。

### `unable to determine PR number for <branch>`

`implement` で `gh pr create` 直後の URL parse が失敗し、続く `gh pr list --head` でも見つからない。`gh` 認証スコープ（`workflow` 必要）と `gh` バージョン、`base_branch` 設定を確認。

## FAQ

### Q. 並列で複数 issue を処理できる？

A. v0.1.0 では `parallel: 1` を実質前提にしており、`run` のメインループも 1 件取りきるまで進む。複数 issue を同時に進めたい場合は v0.2 以降を待つ。

### Q. base branch を `main` 以外にしたい

A. `config.yaml` で:

```yaml
base_branch: develop
```

空文字なら `main` にフォールバック（`packages/cli/src/executor.ts: baseBranch`）。

### Q. branch 名 prefix を変えたい

A. `config.yaml` で:

```yaml
branch_prefix: "bot/"
```

デフォルトは `"autokit/"`。

### Q. auto-merge を無効化したい

A.

```yaml
auto_merge: false
```

`merging` フェーズで予約せず、PR を手動 merge する運用になる。merge 後 `autokit run` で `cleaning` まで進む。

### Q. 同じ issue を再投入したい（過去の merged を改めて流す）

A. `autokit add <N> --force`。新しい branch / worktree は `-retry-{N}` suffix が付く。

### Q. レビューの上限を増やしたい

A.

```yaml
review:
  max_rounds: 5
```

ただし上げすぎるとループが長引く。`warn_threshold` も合わせて調整。

### Q. logs はどこ？

A. `.autokit/logs/`。`logging.level` `logging.retention_days` `logging.max_*` `logging.redact_patterns` で挙動制御。

### Q. tasks.yaml を手で編集していい？

A. 推奨しない。書き換えタイミングが atomic でないと corruption になり `autokit retry --recover-corruption` 行きになる。どうしても必要なら、`autokit list --json` を引き写し、エディタで保存し、再度 `autokit list` で読めることを確認すること。

### Q. `autokit doctor` の `prompt contracts` が `WARN` のままだけど動く？

A. `init` 前は WARN（`.agents/prompts/` 未生成）が正常。`init` 後も WARN なら `.agents/prompts/` の中身が欠落している。`init --dry-run` で期待ファイル一覧を出して照合。

### Q. CI 待ち時間中に他 issue を進めたい

A. v0.1.0 では同時には不可。CI 待ちの issue が paused / ci_waiting で進行を占有する。完了するまで他は queued のまま。

### Q. 監査鍵 (`audit-hmac-key`) を誤って消した

A. `.autokit/.backup/` のタイムスタンプ付き backup を確認。無ければ既存監査ログとの整合は取れない。新しい鍵で続行する場合は、過去の `sanitize_pass_hmac` 値が検証不能になることを承知の上で `init` を `--force` で実行（`audit-hmac-key` は backup_blacklist に含まれるため自動退避はされない）。

### Q. private repo の issue を扱える？

A. 可能。`gh auth status` が `repo` 権限を持っていればよい。

### Q. v0.2 以降の機能は？

A. SDK runner matrix・public registry publish・branch protection 設計の汎用化等。`docs/PLAN.md` を参照。

## 関連

- 復旧手順: [06-recovery.md](./06-recovery.md)
- 設定値: [04-configuration.md](./04-configuration.md)
- コマンド: [03-commands.md](./03-commands.md)
- 仕様正典: [`docs/SPEC.md`](../../docs/SPEC.md)
