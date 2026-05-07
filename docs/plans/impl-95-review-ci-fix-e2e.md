# Issue #95 review-fix / ci-fix loop E2E

## Goal
review-fix / ci-fix loop の停止理由 4 種と loop audit sequence を、mock runner / fake GitHub 境界で観測可能にする。

## Observable Success Criteria
- `review.max_rounds=2` の 3 回目 accept で `failure.code=review_max` を観測できる。
- `ci.fix_max_rounds=2` の 3 回目 CI failure で `failure.code=ci_failure_max` を観測できる。
- cold restart 上限で `failure.code=phase_attempt_exceeded` を観測できる。
- self-correction retry 後の 2 回目 prompt contract 違反で `failure.code=prompt_contract_violation` を観測できる。
- review-fix loop で `phase_started -> review_finding_seen -> fix_started -> fix_finished -> review_started` の順序を audit log から検証できる。
- ci-fix loop で fake GitHub の CI failure log を使い、CI-origin fix 後に review/supervise へ戻ることを検証できる。

## Key Constraints
- 1 child Issue = 1 PR。#95 では logs/diff (#97) や Phase E 統合 E2E は扱わない。
- live provider / API-key-backed run は実行しない。fake `WorkflowRunner` / fake GitHub で検証する。
- ユーザー承認により、Issue plan の元記述「SPEC 同 PR 更新なし」は audit sequence kind 追加に限って上書きする。`docs/SPEC.md` §10.2.2.1 と `packages/core/src/logger.ts` を同期し、trace gate を通す。
- 新 failure.code は追加しない。

## Relevant Skills / Tools
- `issue-implementation`: Issue / SSOT 起点の TDD 実装。
- `plan-writing`: 短い実装計画と検証条件の固定。
- `general-review`: PR 作成後の多角レビュー。
- `review-fix`: valid finding の root-cause 修正。

## Execution Steps
- [x] RED: `e2e/runners/review-fix-loop.test.ts` と `e2e/runners/ci-fix-loop.test.ts` を追加し、既存未実装 audit kind で失敗させる。
- [x] GREEN: workflow 境界で loop audit operation を発火し、`operationalAuditKinds` と SPEC §10.2.2.1 を同期する。
- [x] E2E helper: fake GitHub の CI check / failed log fixture を `e2e/runners` 側に閉じて追加する。
- [x] Regression: `packages/workflows/src/index.test.ts` の既存 state-machine unit coverage を壊さないことを確認する。
- [x] Verification: targeted tests -> lint/typecheck/test/build -> `bash scripts/check-trace.sh`。
