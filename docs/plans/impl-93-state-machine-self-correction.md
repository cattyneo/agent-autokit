# Issue #93 state-machine E34 and self-correction

## Goal
E34 (`prompt_contract_violation`) を `runtime.phase_self_correct_done=true` 前提に改訂し、初回 prompt contract violation は workflow 内 self-correction retry として 1 回だけ回復可能にする。

## Observable Success
- `phase_self_correct` / `phase_override_started` / `phase_override_ended` が operational audit kind として SPEC と実装で同期する。
- 初回 `prompt_contract_violation` は `runtime.phase_self_correct_done=true` 永続化、`phase_self_correct` audit、同 phase retry に進む。
- 2 回目の violation は `failure.code=prompt_contract_violation` で failed になる。
- `phase_self_correct_done=true` を持つ resume 状態では二重 retry せず、次の violation は即 failed になる。
- 同一 phase cold restart は `runtime.phase_attempt++` し、`>=3` で `phase_attempt_exceeded` に failed 化する。
- SPEC §5.1 E34 condition と §10.2.2.1 operational audit kind が同 PR で更新され、trace check が通る。

## Scope
- `packages/core/src/logger.ts` / logger tests の audit kind 追加。
- `packages/core/src/state-machine.ts` / tests の E34 condition 表現、phase transition 時 self-correct flag 初期化、phase_attempt helper。
- `packages/workflows/src/index.ts` / tests の `runWithSelfCorrection` 統合、runner `prompt_contract_violation` と `requireStructuredData` failure の recoverable 化。
- `docs/SPEC.md` の E34 condition / operational audit kind 同期。

## Non-goals
- review/ci loop E2E は #95。
- CLI phase/provider/effort override 受理と `phase_override_*` 発火実装は #94。#93 では audit kind と SPEC trace だけを追加する。
- live provider subprocess / API-key-backed run は実行しない。
- Phase 4 prompt free-text 改善は対象外。

## Test Scenarios
- workflow: 初回 violation → retry → completed payload で phase 進行。
- workflow: 2 回目 violation → `prompt_contract_violation` failed。
- workflow: `phase_self_correct_done=true` の resume 状態 → violation で即 failed。
- workflow: runner spawn failure / timeout / sandbox violation は self-correction 対象外の既存経路。
- workflow/state-machine: phase transition / retry reset で self-correct flag と phase_attempt が期待通り。
- trace: `bash scripts/check-trace.sh` が通る。

## AC
- Issue #93 body and `docs/references/v0.2.0-issue-plan.md` Issue 1.7 AC を満たす。
- New `TransitionEvent` は追加しない。
- SPEC 同 PR 更新は `docs/SPEC.md` §5.1 / §10.2.2.1 のみ。
- Required gate へ昇格するテストに `test.todo` / `describe.skip` を残さない。

## Execution Steps
- [x] RED tests: logger audit kind、SPEC E34 grep、self-correction retry / second violation / resume inheritance / non-recoverable runner error / phase_attempt exceeded。
- [x] Core updates: audit kind list、state-machine helper / reset behavior、SPEC sync。
- [x] Workflow updates: recoverable prompt contract violation path and `runWithSelfCorrection` helper。
- [x] Targeted checks, trace check, then required gates.
