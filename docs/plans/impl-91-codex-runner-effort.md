# Issue #91 Codex runner effort + payload schema commonization

## Goal
Codex runner を全 7 agent phase で受理し、resolved effort を `codex exec -c model_reasoning_effort=<value>` に反映しつつ、既存 strict output schema と resume behavior を維持する。

## Observable Success
- `buildCodexArgs()` が 7 phase すべてを受理し、phase profile に応じて `--sandbox read-only|workspace-write` を選ぶ。
- `effort=auto|low|medium|high` が `model_reasoning_effort=medium|low|medium|high` として `-c` config override に乗り、`--reasoning-effort` は使わない。
- `parseCodexFinalOutput()` は core `validatePromptContractPayload()` で 7 contract を検証し、schema 違反を fail-closed にする。
- `codexPromptContractJsonSchema()` の strict surface (`required data/question`, null union, plan-verify ok/ng shape) は維持される。

## Constraints
- Scope は #91 のみ。Claude effort profile (#92)、Claude Bash guard (#90)、audit / state-machine owner は触らない。
- live provider subprocess / API-key-backed run は実行しない。
- Context7 `/openai/codex` と local `codex exec --help` で、`-c/--config key=value` と `--sandbox` を確認済み。`--reasoning-effort` は採用しない。

## Tasks
- [x] Codex runner tests を先に更新: 7 phase sandbox matrix、4 effort args、schema violation、schema snapshot 不変を追加する。
- [x] `packages/codex-runner/src/index.ts` の phase whitelist を capability phase SoT に置換し、sandbox を permission profile 由来にする。
- [x] `buildCodexArgs()` に `-c model_reasoning_effort=<value>` を追加し、`auto` は `medium` に正規化する。
- [x] final output validation が全 prompt contract を通ることを既存共通 validator で確認し、不足があれば schema helper を最小更新する。
- [x] `docs/SPEC.md` §11.4.3 に Codex runner sandbox 動的化 / effort config override を同期する。
- [x] Targeted tests → required gates (`lint`, `typecheck`, `test`, `build`) を実行し、trace 影響があれば `bash scripts/check-trace.sh` も実行する。

## Done When
- [x] Issue #91 AC と non-goals が PR body に明記される。
- [x] `npx --yes bun@1.3.13 test packages/codex-runner/src/index.test.ts packages/core/src/capability.test.ts` が通る。
- [x] required gates が通り、provider-backed tests は not run として明示される。
