# Codex exec 切替に伴う修正プラン

## 目的

Codex SDK primary 前提の SPEC / PLAN / Issue train を、OpenAI Platform API key / usage-based API billing を使わない `codex exec` primary 前提へ修正し、実装再開可能な状態に戻す。

## 完了状態

- SPEC / PLAN が `claude -p primary + codex exec primary` に統一されている。
- Codex SDK は v0.1.0 の採用対象から外れ、deferred / paid-risk-gated として扱われている。
- Issue #23 は Claude CLI gate と Codex exec gate に分離されている、または replacement Issue に置換されている。
- AK-009 は Claude CLI evidence gate のみに依存している。
- AK-010 は `codex exec` subscription-auth evidence gate に依存し、`codex-cli-exec-runner` 前提で再開可能。
- `OPENAI_API_KEY` / `CODEX_API_KEY` / `ANTHROPIC_API_KEY` を使う経路は fail-closed として明文化されている。
- `codex exec` の pinned CLI 機能確認結果が `docs/spike-results.md` に記録されている。
- SPEC / PLAN は `claude -p` で Claude を利用し、`general-review` skill によるレビューを完了している。
- Claude review の blocker / major は解消、または明示的に見送り判断されている。

## 全体方針

- 先にドキュメントと Issue train を直す。
- その後に runner 実装を再開する。
- 修正の実行主体は Codex とする。
- Claude は `claude -p` + `general-review` skill によるレビュー専用とする。
- Claude に git / gh / PR / merge 操作を行わせない。
- Codex SDK / Claude Agent SDK / API key execution は explicit paid-eval approval なしに実行しない。
- ChatGPT-managed auth でも subscription quota / rate limit / paid entitlement の消費リスクは残るため、高回数実行は operator approval scope に含める。
- Claude CLI の高回数 full matrix も、subscription / billing 扱い確認または operator 承認なしに実行しない。
- `packages/codex-runner` の directory / package 名は原則維持し、Issue 名・scope 名だけを新方針へ寄せる。
- 不明なコードベース事情や未確認CLI機能は決め打ちせず、確認タスクまたは判断方針として扱う。

## タスク

### R0. 現状棚卸しと停止宣言

目的:
- Issue #23 実行前に runner 方針を固定する。
- SPEC / PLAN / Issue #23 / AK-009 / AK-010 に残る Codex SDK 前提を洗い出す。
- 旧 evidence を `codex exec` 採用証跡として誤流用しない。

成果物:
- `docs/codex_exec_migration_inventory.md` を MIG-001 / R0 の棚卸し成果物とする。
- この inventory は、SPEC / PLAN / Issue / `docs/spike-results.md` 単位で、v0.1.0 に残す対象と deferred / paid-risk-gated へ移す対象を分離する。

作業:
- 現行 #23 / AK-010 / runner full matrix を停止扱いにする。
- Issue / PR コメントに「Codex SDK full matrix は v0.1.0 から外し、deferred / paid-risk-gated 別 Issue へ移送」と記録する。
- 同様に Claude Agent SDK full matrix も deferred / paid-risk-gated 別 Issue へ移送する旨を記録する。
- `Codex SDK`, `@openai/codex-sdk`, `runStreamed`, `resumeThread`, `codex_thread_id`, `OPENAI_API_KEY`, `CODEX_API_KEY` を検索する。
- `codex exec`, `--json`, `--output-schema`, `--output-last-message`, `-o`, `resume`, `thread_id`, `session_id` を検索する。
- `docs/spike-results.md` を確認し、確認済み evidence と未確認前提を分離する。
- AK-009 / AK-010 の blocked-by に #23 が残っている箇所を確認する。
- `packages/codex-runner` の directory / package 名が既に存在する場合は、rename が必要かを確認する。

完了条件:
- 修正対象リストが作成されている。
- v0.1.0 に残す箇所と deferred に移す箇所が分離されている。
- 現行 #23 をそのまま実行しない方針が記録されている。
- SDK/API実行およびClaude高回数matrixが承認なしに発生していない。

レビュー観点:
- SDK primary 前提の見落としがない。
- Codex CLI と Codex SDK の用語が混在していない。
- 旧 SDK evidence が `codex exec` runner 採用証跡として扱われていない。
- package / directory rename を不要に大きな差分として要求していない。

---

### R1. SPEC 修正

目的:
- SPEC を `codex exec` primary の SSOT に更新する。

作業:
- 概要、用語、ディレクトリ、runtime prerequisite、auth、runner contract、採用基準、prompt_contract、question loop、AC を更新する。
- `Codex SDK primary` を v0.1.0 primary から外す。
- `runStreamed` / `resumeThread` を v0.1.0 必須要件から外す。
- Codex SDK は deferred / paid-risk-gated としてのみ残す。
- `OPENAI_API_KEY` / `CODEX_API_KEY` / `ANTHROPIC_API_KEY` unset 必須を全関連箇所へ反映する。
- Codex auth は ChatGPT-managed CLI auth のみ許可する。
- API key auth 検出時は fail-closed とする。
- `codex exec --json` / `--output-schema` / `codex exec resume <session_id>` は、R5 の pinned CLI evidence が確認済みの場合のみ Codex runner の基本形として記述する。
- R5 未完了の時点では、exact flags / session ID field / final output 取得方法を placeholder または AK-010 実装前の停止条件としてのみ記述する。
- `--output-last-message` / `-o` や JSONL event 名は、R5 の pinned CLI evidence に基づく前提として記述する。
- `codex_thread_id` を `codex_session_id` に変更するか、field 名は維持して意味だけCLI sessionに変更するかを決める。
- v0.1.0 GA 前は破壊的変更を許容する原則を明記する。
- `tasks.yaml` 既存フォーマットを変更する場合、(a) migration helper 同梱 (b) 旧 key alias 受容 (c) 既存 worktree 破棄前提の破壊的変更、のいずれを採用するか実装タスクで決定する旨を明記する。
- いずれを採用するにせよ、決定根拠と影響範囲を SPEC / PLAN / 実装 Issue に記録する。
- doctor と runner auth の責務境界を明記する。
- failure.code / audit kind の追加要否を判断する (例: `approval_unavailable`、`codex_auth_unsupported`、`codex_session_resume_unsupported` 等)。
- 追加する場合は SPEC failure.code 表 / audit kind / AC / PLAN traceability を同時更新する。
- 追加不要と判断した場合は、既存 `network_required` / `sandbox_violation` / `prompt_contract_violation` 等で十分な根拠を記録する。
- `~/.codex/auth.json` / `$CODEX_HOME/auth.json` を password 相当として扱う。
- sanitize / log redaction / artifact 除外対象に Codex auth file と token field を追加する。

完了条件:
- SPEC 内の v0.1.0 primary runner が `codex exec` に統一されている。
- `runStreamed` / `resumeThread` は v0.1.0 必須要件として残っていない。
- Codex SDK は deferred / paid-risk-gated としてのみ残っている。
- `CODEX_API_KEY` が env禁止対象として明記されている。
- `codex_thread_id` rename / 維持 / migration 方針 (a/b/c のいずれか) が決定根拠付きで明記されている。
- v0.1.0 GA 前の破壊的変更許容原則が明記されている。
- failure.code / audit kind の追加要否判断結果と根拠が SPEC / PLAN に記録されている。
- 追加した failure.code / audit kind があれば、failure.code 表 / audit kind / AC / traceability が集合一致している。
- `codex exec` CLI機能の未確認項目が実装必須前提として断定されていない。

レビュー観点:
- 変更後も state machine / checkpoint / core ownership が崩れていない。
- Codex `need_input` が final output → TUI → resume turn として表現されている。
- failure.code / audit kind を追加した場合、全表が同期されている。
- doctor と `codex-runner/auth.ts` の責務が重複しても矛盾しない。
- auth file の値が log / issue / review artifact / spike-results に混入しない設計になっている。

---

### R2. PLAN 修正

目的:
- 実装計画と Issue breakdown を `codex exec` primary に合わせる。

作業:
- v0.1.0 scope、S0、S2、S3、テスト戦略、リスク表、重要原則、traceability を更新する。
- `runner: claude -p primary + Codex SDK` を `runner: claude -p primary + codex exec primary` に変更する。
- AK-010 を `codex-cli-exec-runner` 相当に変更する。
- AK-010 の scope を `codex exec` auth / runner / resume / sandbox / JSONL parser / output schema validation / process group / hard timeout / question turn-loop に置換する。
- AK-009 は Claude runner のみを扱い、Codex exec gate に依存させない。
- AK-010 は Codex exec evidence gate に依存させ、Claude full matrix gate に依存させない。
- Codex SDK runner は非ゴールまたは v0.2+ 候補へ移す。
- Claude Agent SDK full matrix は paid-risk-gated deferred として扱う。
- Claude CLI N=20 / N=80 等の高回数実行は、subscription / billing 扱い確認または operator 承認を要求する。
- `packages/codex-runner` の directory / package 名は原則維持し、説明を CLI exec wrapper に変更する。
- PLAN §5.5 traceability に `CODEX_API_KEY` / `codex exec` / CLI feature evidence / auth file sanitize を反映する。
- `codex-runner` test matrix を SDK mock 前提から CLI exec subprocess mock 前提に置換する。
- 追加 fixture: `codex exec --json` JSONL event sample、final JSON schema 適合 / 違反、`codex exec resume <session_id>` resume サンプル。
- 追加 rejection fixture: `CODEX_API_KEY` / `OPENAI_API_KEY` set 時 fail、API key auth mode 検出時 fail、`--output-schema` schema mismatch 時 `prompt_contract_violation`、approval prompt 発生時 fail-closed。
- 既存 `claude-runner` / `core` test に `CODEX_API_KEY` scrub 検証 case を追加する。
- `~/.codex/auth.json` の値が log / artifact / issue body へ流出していないことを検証する fixture を追加する。

完了条件:
- PLAN の runner 方針が SPEC と一致している。
- AK-009 の scope / blocked-by / AC / tests が Claude runner 前提である。
- AK-010 の scope / blocked-by / AC / tests が `codex exec` 前提である。
- #23 の位置づけが SDK full matrix ではなく CLI exec evidence gate になっている。
- Claude高回数matrixの費用・subscription扱い確認が gate として明記されている。
- `codex-runner` test matrix が CLI exec subprocess mock 前提に置換されている。
- JSONL event / final JSON schema / resume / `CODEX_API_KEY` rejection / API key auth fail / auth file 流出検証の fixture / test 追加が AK-010 / AK-002 系 test に明記されている。

レビュー観点:
- Sprint / Issue dependency が循環していない。
- AK-009 / AK-010 が paid eval を前提にしない。
- AK-009 と AK-010 の blocker が混同されていない。
- S2 / S3 の作業単位が実装者に十分伝わる。
- package / directory rename を不要な必須作業にしていない。

---

### R3. Issue #23 の rewrite または置換

目的:
- API費用リスクを含む full matrix gate を止め、Claude CLI gate と Codex exec gate に分離する。

作業:
- 現 #23 に `blocked_by_cost_policy` または同等の status を付ける。
- #23 を rewrite するか、replacement Issue を作成する。
- Claude CLI evidence gate と Codex exec subscription-auth evidence gate を分離する。
- AK-009 は Claude CLI evidence gate のみを参照する。
- AK-010 は Codex exec evidence gate のみを参照する。
- `@openai/codex-sdk` N=20 実行を #23 から削除する。
- Codex SDK full matrix は別 Issue として `deferred / paid-risk-gated` に移す。
- Claude Agent SDK full matrix も `deferred / paid-risk-gated` に移す。
- Claude CLI 高回数 full matrix は、subscription / billing扱い確認または operator承認を完了条件に含める。
- Codex exec gate には R5 の feature確認を含める。
- paid/API execution は明示承認なしに実行しない、と記載する。

完了条件:
- #23 から `@openai/codex-sdk` N=20 実行が削除されている。
- `codex exec` ChatGPT-managed auth evidence が AK-010 gate になっている。
- Claude CLI evidence が AK-009 gate として独立している。
- Codex SDK / Claude Agent SDK full matrix は deferred / paid-risk-gated issue に分離されている。
- paid/API execution は明示承認なしに実行しない、と記載されている。

レビュー観点:
- Issue本文だけ読んでも API key / SDK 実行禁止が分かる。
- AK-009 / AK-010 の blocker が適切な gate に差し替わっている。
- operator approval の範囲が曖昧でない。
- Claude CLI の cost telemetry を実課金証跡として断定していない。
- full matrix と low-cost evidence が混同されていない。

---

### R4. 認証・費用ガードの反映

目的:
- OpenAI Platform API key / usage-based API billing 経路を仕様上 fail-closed にする。

作業:
- doctor 検査に `CODEX_API_KEY` を追加する。
- login-shell env probe / cwd `.env*` / child env allowlist / sanitize / AC / tests に `CODEX_API_KEY` を追加する。
- `OPENAI_API_KEY` / `CODEX_API_KEY` / `ANTHROPIC_API_KEY` が set されている場合、`run` / `resume` / `doctor` は fail する方針を追加する。
- runner 子プロセスへ API key が継承されない方針を追加する。
- Codex auth mode が API key の場合は fail する方針を追加する。
- `codex login status` の表示を利用する場合、ChatGPT-managed auth と API key auth の判別方法を確認タスクとして明記する。
- API key auth 時の `codex login status` 出力が未確認なら、string match を決め打ちせず fail-closed または別 probe 方針を記述する。
- doctor は autokit process / login-shell / dotfile / config / env allowlist を検査する、と明記する。
- `codex-runner/auth.ts` は runner spawn 直前の `codex login status` probe と child env scrub を担当する、と明記する。
- `~/.codex/auth.json` / `$CODEX_HOME/auth.json` / `.codex/auth*` / `.codex/credentials*` を backup / logs / artifacts / issue body から除外する。
- sanitizer に `access_token` / `refresh_token` / `id_token` / `oauthAccessToken` / `refreshToken` / `token` 系 field の mask 方針を追加する。

完了条件:
- `OPENAI_API_KEY` / `CODEX_API_KEY` のどちらでも `run` / `resume` / `doctor` が fail する仕様になっている。
- runner 子プロセスへ API key が継承されない。
- auth.json が backup / logs / artifacts / issue body / review artifact に混入しない。
- `codex login status` parse または代替 probe の判断方針が明記されている。
- doctor と runner auth の責務境界が明記されている。

レビュー観点:
- `CODEX_API_KEY` が `codex exec` 専用の API key 経路として扱われている。
- ChatGPT-managed auth と API key auth の区別が明確である。
- API key auth 判別不能時の fail-closed 方針がある。
- CI で ChatGPT auth を扱う場合の制限が明記されている。
- auth file の値が二次漏洩しない。

---

### R5. `codex exec` CLI 機能確認 spike

目的:
- `codex exec` runner の前提機能を pinned Codex CLI で確認する。
- 未確認の CLI event 名・field 名を実装必須前提にしない。

作業:
- pinned Codex CLI version / `which` / checksum / install source を記録する。
- `codex exec --json` の JSONL event stream を確認する。
- session ID の取得方法を確認する。
- JSONL event に `thread.started.thread_id` 等が存在するか確認する。存在しない場合は実際の field 名を記録する。
- `codex exec resume <SESSION_ID>` の存在と動作を確認する。
- `codex exec resume --last` の存在と動作を確認する。
- `--output-schema` の動作を確認する。
- `--output-last-message` / `-o` の存在と動作を確認する。
- `--sandbox read-only` / `--sandbox workspace-write` の指定方法と動作を確認する。
- approval policy 指定方法を確認する。
- `-a never` または同等の approval fail-closed 指定を確認する。
- ChatGPT-managed auth で `OPENAI_API_KEY` / `CODEX_API_KEY` unset のまま実行できることを確認する。
- `OPENAI_API_KEY` / `CODEX_API_KEY` set 時の検出動作を、dummy / sentinel env または mock / probe で runner spawn 前に fail する証跡として確認する。
- real API key を設定した live provider call は、この issue train の完了条件に含めない。
- `codex login status` の ChatGPT-managed auth 表示を確認する。
- API key auth 表示が未確認なら、実装では API key auth 判別不能時に fail-closed する方針を記録する。

完了条件:
- `docs/spike-results.md` に実行日時、version、invocation、stdout/stderr要約、event sample、session ID抽出方法、失敗時の扱いが記録されている。
- `codex exec resume` / `--output-last-message` / JSONL session ID field の確認結果が記録されている。
- 未確認機能がある場合、SPEC / PLAN / Issue に「未確認、実装前に停止」と記載されている。
- `codex exec` evidence と Codex SDK evidence が混同されていない。
- API key present rejection は model call 前の dummy / sentinel env または mock / probe で確認され、real API key backed execution を要求していない。

レビュー観点:
- 未確認のCLI event名・field名を実装必須前提にしていない。
- 公式docsだけでなく pinned local version の実機 evidence がある。
- 認証状態が API key auth に落ちていない。
- sandbox / approval / resume の失敗時方針が fail-closed である。

---

### R6. Runner contract / prompt_contract の整合

目的:
- SDK前提の thread API を CLI subprocess 前提に置換する。

作業:
- R5 の evidence に基づき、`codex exec --json` JSONL event fixture を定義する。
- final JSON は `--output-schema` / `--output-last-message` で取得する前提にする。ただし R5 で未確認なら fallback または停止条件を明記する。
- `codex exec resume <session_id>` を resume 手段にする。ただし R5 で未確認なら実装前に停止する。
- Codex `need_input` は final output として扱い、回答後に resume turn を開始する。
- AgentRunInput / AgentRunOutput は provider共通 contract を維持する。
- `codex_thread_id` rename / 維持方針を AgentRunInput / AgentRunOutput / tasks.yaml / retry cleanup / reconcile / tests と同期する。
- Claude runner は既存 YAML/JSON parse を維持してよい。
- Codex runner は final JSON + schema validation へ寄せる。

完了条件:
- AgentRunInput / AgentRunOutput が CLI exec でも成立する。
- session id 保存 / resume / schema validation の流れが明記されている。
- YAML parse 前提が Codex runner の必須要件になっていない。
- JSONL events と final output の責務が分離されている。
- rename 方針が schema / resume / AC と同期されている。

レビュー観点:
- Claude runner と Codex runner の parse 差異が内部 contract で吸収されている。
- final output と JSONL events の責務が分離されている。
- event 名・field 名は公式 docs / 実機 evidence で確認する前提になっている。
- 既存 tasks.yaml 互換性の扱いが明確である。

---

### R7. Traceability / AC 同期

目的:
- SPEC / PLAN の変更漏れをレビュー可能にする。

作業:
- SPEC §13 AC を更新する。
- PLAN §5.5 traceability を更新する。
- Issue breakdown の対応 AC / 対応テストを更新する。
- 変更により追加された failure.code / audit kind があれば集合一致を保つ。
- `CODEX_API_KEY` rejection の AC を追加する。
- `codex exec --json` / `--output-schema` / output file / resume / sandbox / approval fail-closed の AC を追加する。
- `~/.codex/auth.json` / `$CODEX_HOME/auth.json` の sanitize / artifact 除外 AC を追加する。
- `codex login status` parse または代替 probe の AC を追加する。
- Claude review (`claude -p` + `general-review`) の実施を再開前条件に追加する。

完了条件:
- Codex SDK 前提の AC が v0.1.0 必須条件から消えている。
- `codex exec` runner の AC が追加されている。
- `CODEX_API_KEY` rejection の AC がある。
- auth file sanitize / artifact除外の AC がある。
- traceability が古い文言を参照していない。

レビュー観点:
- AC が実装タスクと対応している。
- deferred 項目が v0.1.0 GA 条件に混入していない。
- traceability が古い Codex SDK 文言を参照していない。
- Claude review 工程がレビュー専用として表現されている。

---

### R8. `docs/spike-results.md` 整理

目的:
- 既存 spike evidence を新方針で誤解されない形に整理する。

作業:
- Codex SDK `runStreamed` / `resumeThread` smoke evidence がある場合、`Deferred / paid-risk-gated reference` と注釈する。
- Codex SDK evidence を v0.1.0 Codex runner adoption gate として扱わない旨を記録する。
- Codex exec evidence を新規 section として分離する。
- R5 で確認済みの `codex exec` feature と未確認 feature を明記する。
- Claude CLI cost telemetry がある場合、subscription利用時の実課金証跡とは断定しない旨を維持する。
- Claude高回数matrixは subscription / billing扱い確認または operator承認なしに実行しない旨を記録する。

完了条件:
- SDK evidence / Codex exec evidence / Claude evidence が分離されている。
- deferred evidence が v0.1.0 blocker に混入していない。
- 未確認 CLI feature が未確認として記録されている。

レビュー観点:
- 過去 evidence の再利用範囲が明確である。
- cost telemetry と実課金が混同されていない。
- Issue #23 rewrite と矛盾していない。

---

### R9. SPEC / PLAN Claude review

目的:
- SPEC / PLAN の方針変更が全体として整合しているか、実装前に独立レビューする。

作業:
- `claude -p` で Claude を起動し、`general-review` skill を使って SPEC / PLAN / 関連docs / PR diff をレビューする。
- review input には少なくとも `docs/SPEC.md`, `docs/PLAN.md`, `docs/codex_exec_migration_plan.md`, #23 / AK-009 / AK-010 の更新方針を含める。
- Claude review の指摘を記録する。
- blocker / major / minor を分類する。
- blocker / major は Codex が修正する。
- 修正後、必要に応じて Claude review を再実行する。
- 見送り判断する場合は理由と影響範囲を記録する。

完了条件:
- Claude review finding が記録されている。
- blocker / major が解消されている、または明示的に見送り判断されている。
- Claude review の結果が SPEC / PLAN / #23 / AK-009 / AK-010 の再開判断に反映されている。

レビュー観点:
- Codex SDK primary 残存がない。
- API key 経路残存がない。
- AK-009 / AK-010 の依存分離が正しい。
- AC / traceability が同期されている。
- 旧 evidence が誤流用されていない。
- 費用方針違反がない。
- Claude が修正主体や git/gh 操作者になっていない。

---

### R10. 再開前レビュー

目的:
- 実装再開前に方針の一貫性を確認する。

作業:
- SPEC / PLAN / #23 / AK-009 / AK-010 / blocked-by / `docs/spike-results.md` の差分を読む。
- `Codex SDK primary` が残っていないことを機械検索する。
- `runStreamed` / `resumeThread` が v0.1.0 必須要件として残っていないことを機械検索する。
- `CODEX_API_KEY` 禁止が全関連箇所に反映されていることを確認する。
- `codex exec` 実機 evidence は実行前に operator が範囲を承認していることを確認する。
- R5 の CLI feature確認が実装前提に十分か確認する。
- `codex_thread_id` rename / 維持 / migration 方針が実装タスクと同期していることを確認する。
- Claude review の blocker / major が残っていないことを確認する。

完了条件:
- 方針レビューが完了している。
- 実装再開対象 Issue が明確である。
- #23 の扱いが決まっている。
- AK-009 / AK-010 の blocked-by が更新されている。
- `Codex exec primaryで再開可` と判断されている。

レビュー観点:
- 実装者が API key / SDK を使う余地が残っていない。
- paid eval と low-cost evidence が分離されている。
- 再開時の最初の作業が一意である。
- 未確認CLI機能を実装で決め打ちしない。
- 既存 package / directory 名の不要な変更がない。

## 推奨順序

1. R0 棚卸しと停止宣言
2. R1 SPEC 修正
3. R2 PLAN 修正
4. R3 #23 rewrite / replacement
5. R4 認証・費用ガード反映
6. R5 `codex exec` CLI 機能確認 spike
7. R6 runner contract / prompt_contract 整合
8. R7 AC / traceability 同期
9. R8 `docs/spike-results.md` 整理
10. R9 SPEC / PLAN Claude review
11. R10 再開前レビュー

## 実装再開の条件

- SPEC / PLAN の修正 PR がレビュー済み。
- SPEC / PLAN が `claude -p` + `general-review` skill でレビュー済み。
- Claude review の blocker / major が解消、または明示的に見送り判断済み。
- #23 が停止または置換済み。
- AK-009 が Claude CLI runner gate として再定義済み。
- AK-010 が `codex exec` runner として再定義済み。
- Codex SDK full matrix が v0.1.0 blocker から外れている。
- Claude Agent SDK full matrix が v0.1.0 blocker から外れている。
- Claude CLI 高回数matrixの subscription / billing 扱い確認または operator承認条件が明記済み。
- API key auth を使わない方針が doctor / env / issue / AC に反映済み。
- `CODEX_API_KEY` が禁止envとして反映済み。
- `~/.codex/auth.json` / `$CODEX_HOME/auth.json` の機密扱いが sanitizer / logger / artifact hygiene / backup 除外に反映済み。
- `codex exec` の pinned CLI feature確認が `docs/spike-results.md` に記録済み。
- `codex_thread_id` rename / 維持 / migration 方針 (a/b/c) が決定根拠付きで明記済み。
- failure.code / audit kind の追加要否判断結果が SPEC / PLAN に反映済み。追加した場合は failure.code 表 / audit kind / AC / traceability が集合一致済み。
- `packages/codex-runner` の directory / package 名を維持するか、rename が必要な場合は理由が明記済み。

## 判断基準

- 仕様変更だけで完了し、実 runner 実行を伴わない修正は進めてよい。
- `codex exec` の one-shot smoke は ChatGPT-managed auth / API key unset を確認してから実行する。
- Codex SDK / API key を使う作業は別Issueで明示承認を要求する。
- Claude Agent SDK を使う作業は別Issueで明示承認を要求する。
- Claude CLI 高回数matrixは subscription / billing 扱い確認または operator承認を要求する。
- ChatGPT-managed auth の `codex exec` でも usage limit / quota / entitlement 消費は別リスクとして記録し、高回数matrixでは operator approval scope に含める。
- SPEC / PLAN review は `claude -p` + `general-review` skill で行い、修正は Codex が行う。
- 不明な認証状態では実行せず、doctor / auth evidence を先に取る。
- CLI feature が公式docsにあっても pinned local version で未確認なら実装必須前提にしない。
- 既存コードベースに関する未確認事項は、判断方針または確認タスクとして扱う。
