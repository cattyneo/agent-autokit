# 06. 復旧プレイブック

> この章で解決すること: 終了コード `75` が出たとき、`paused` task を見つけたとき、cleanup が中途半端なときに「次に何を打つか」を決められる。

## 終了コードの読み方

| code | 意味 | 次の打鍵 |
|------|------|----------|
| `0` | 全件 `merged` | 何もしない |
| `1` | `failed` 残存 / 引数誤り | `autokit retry` または手動修正 |
| `2` | 引数構文エラー | コマンド引数を見直す |
| `75` | `paused` / `cleaning` 残存（resumable） | 原因確認 → `autokit run` 再実行 |

`75` は POSIX `EX_TEMPFAIL`。CI 等では「リトライ可能エラー」として扱う。

## 状態を読む

最初にやるのは「何が止まっているか」の把握:

```bash
autokit list
autokit list --json | jq '.[] | select(.state == "paused") | {issue, runtime_phase, code: .failure.code, message: .failure.message}'
```

`failure.code` が分かれば対処が決まる。

## 失敗パターン別プレイブック

### 1. `need_input_pending`

runner（Claude/Codex）が回答待ちの質問を出した。

**原因**: plan / fix で「ライブラリ X と Y どちらを使うか」等の判断要求。

**対処**:

1. 質問内容は TUI 起動時に表示される。または `.autokit/logs/` から該当 phase ログを確認
2. interactive で答えるなら:
   ```bash
   autokit run     # 再実行すると質問プロンプトが TUI で出る
   ```
3. 機械的にデフォルト回答で良いなら:
   ```bash
   autokit run -y  # createNeedInputAutoAnswer が走る
   ```
4. ただし `-y` は active runner question payload が無い場合は何もできず paused のまま。その場合は通常 run へ。

### 2. `merge_sha_mismatch`

PR head SHA と tasks.yaml の `pr.head_sha` が不一致。auto-merge ガードが拒否。

**原因**: 誰かが PR に追加 commit を push した / rebase した / branch を force-push した。

**対処**:

1. `gh pr view <N> --json state,merged,headRefOid` で現状確認
2. 追加 push が正当（自分で意図的にやった）なら:
   - PR を手動 merge する → `autokit cleanup --force-detach <issue>` で後始末
3. 追加 push が想定外（自動化外の介入）なら:
   - 追加 commit の内容を review し、必要なら revert
   - その後 PR を手動 merge → `autokit cleanup --force-detach`

### 3. `retry_cleanup_failed`

cleanup フェーズで再現不能エラーになり、自動再走でも回復しない。

**対処**: `autokit resume` は exit 75 で「retry を使え」と案内するだけ。直接:

```bash
autokit retry <issue>
```

`retry` は PR を close、worktree remove、branch delete を試みて queue に戻す。

### 4. `branch_delete_failed` / `worktree_remove_failed`

PR は merge 済みなのに後始末で失敗。

**対処**:

```bash
autokit cleanup --force-detach <issue> --dry-run
autokit cleanup --force-detach <issue>
```

precondition チェック（PR が MERGED かつ head SHA 一致）を再評価し、OK なら interactive 確認のあと `merged` に確定。NG なら `merge_sha_mismatch` に降格して exit 1。

### 5. CI failure ラウンド上限（`ci_failure_max`）

`config.ci.fix_max_rounds` 回試しても CI が直らない。

**対処**:

1. `gh pr checks <N>` で失敗チェックを確認
2. 失敗が autokit の修正範囲を超える（インフラ起因 / flake / spec バグ）なら:
   - 手動で修正コミット → push → CI 再実行
   - 通ったら `autokit run` 再開（ci_waiting → merging へ進む）
3. 諦める場合: PR を draft に戻す or close → `autokit retry <issue>` で全部やり直すか、手動運用へ移行

### 6. CI timeout（`ci_timeout`）

経過時間が `config.ci.timeout_ms` 超過。`config.ci.timeout_action` 既定で `paused`。

**対処**: GitHub Actions が単に遅い（runner 待ち等）なら、CI 完了を待ってから `autokit run` を再実行。常態的に長引くワークフローなら `config.yaml` で `ci.timeout_ms` を引き上げる。既定値は [04-configuration.md](./04-configuration.md) の `ci.*` フィールド表。

### 7. unsupported effort（`effort_unsupported`）

`effort.unsupported_policy=fail` の状態で、provider / model / effort の組合せが解決できない。

**対処**:

1. `autokit config show --matrix` で対象 phase / provider / effort を確認
2. 対象 phase の `effort` を `auto` / `low` / `medium` / `high` の範囲で下げる
3. 自動 downgrade を許す運用なら:
   ```yaml
   effort:
     unsupported_policy: downgrade
   ```
4. 修正後に `autokit run` を再実行

`downgrade` は成功時に audit kind `effort_downgrade` を残し、`runtime.resolved_effort.downgraded_from` に元 effort を保存する。

### 8. `queue_corruption`

tasks.yaml が壊れた / atomic write 中に強制終了した等。

**対処**:

```bash
autokit retry --recover-corruption <issue>
```

`.autokit/tasks.yaml.bak`（`writeTasksFileAtomic` が atomic rename 前に作る兄弟バックアップ）から tasks.yaml を復元し、対象 issue の存在を確認する（state 復帰は手動）。復元後は `autokit list` で内容を確認。

`.autokit/.backup/<timestamp>/` は **`autokit init` の rollback 専用** であり、tasks.yaml の corruption 復旧には使われない。混同しないこと。

### 9. preset apply abort（`preset_path_traversal` / `preset_blacklist_hit`）

`autokit preset show|apply` が state machine を経由せずに abort した。`tasks.yaml` の task entry は作られない。

**原因**:

- `preset_path_traversal`: 絶対 path / `..` / symlink / NUL byte / `.agents` 外 realpath。
- `preset_blacklist_hit`: `.env*` / `.codex/**` / `.claude/credentials*` / private key / token-like content / protected array 違反。

**対処**:

1. local preset (`.autokit/presets/<name>`) を使っている場合は、問題の entry を削除またはリネーム
2. protected array を本当に置換する必要がある場合だけ `--allow-protected-replace` を検討
3. ただし capability table 由来 hard cap を超える `allowed_tools` 拡大は flag ありでも拒否される
4. 修正後に `autokit preset show <name>`、`autokit preset apply <name>`、`autokit doctor` の順で確認

stderr / audit はカテゴリ表現のみを出すため、機密 path や token literal は表示されない。

### 10. lock 残留（`autokit run` 起動時の lock エラー）

過去の run / serve / preset apply が SIGKILL 等で `.autokit/.lock/` を残したまま終了。

**対処**: グローバル `--force-unlock` フラグは CLI 登録のみで未実装。`holder.json` の PID が生きていないこと、`started_at_lstart` が別プロセスを指していないことを確認した上で:

```bash
# 例（実体ファイルを直接削除する場合）
rm -rf .autokit/.lock
```

その後 `autokit run` 再実行。

## ループしてしまう場合の検討順

`autokit run` を何度叩いても同じ paused に戻る場合:

1. `failure.code` を確認（上のテーブルから対処を選ぶ）
2. `failure.message` の生メッセージを確認
3. `.autokit/logs/` の最新 run ログで stack trace を確認
4. issue 本文 / plan.md / review.md を確認し、runner が要求する判断材料が足りているか
5. それでも進まなければ手動で issue を解決し、`autokit retry <issue>` で queue から外し直す

## 監査ログの活用

操作系イベントは logger 経由で残る。代表的なもの:

- `auto_merge_reserved` / `auto_merge_disabled`
- `branch_deleted`
- `sanitize_pass_hmac`
- `init_rollback` / `init_rollback_failed`
- `effort_downgrade`
- `phase_self_correct`
- `preset_apply_started` / `preset_apply_finished` / rollback 系
- `serve_lock_busy` / `sse_write_failed`

順序確認・誰が何をしたかの追跡に使える。`audit-hmac-key` が漏れたら全イベントの真正性が崩れるので、外部に出さない。

## 関連

- コマンド単位の引数: [03-commands.md](./03-commands.md)
- 失敗 code の正典: [`docs/SPEC.md`](../../docs/SPEC.md) §4.2.1.1 / §5.2
