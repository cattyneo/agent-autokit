---
name: autokit-review
description: Use for autokit review phases that must return scoped findings aligned with the configured prompt contract.
---

# autokit-review

Use this skill for `review` phases.

Source alignment: adapted from local `general-review` source fingerprint `sha256:b95eddbaa3e3c671c657084d8919a0a34d031dec60a6228d08158514a742d7f5` for autokit prompt_contract review phases.

## Review Mode
- Stay read-only. Do not edit files, run destructive commands, push branches, merge PRs, or mutate GitHub state.
- Review the issue, plan, SPEC/PLAN references, diff, changed tests, relevant adjacent code, and validation evidence.
- Keep findings high-signal and scoped to the active issue. Discard style-only comments, speculative redesign, duplicate symptoms, and work owned by later issues.
- If key evidence is missing or the review cannot be completed safely, return `status=need_input` through `autokit-question`.

## Review Focus
- Correctness, behavior regressions, state-machine or prompt_contract drift, and unsafe assumptions.
- SPEC/PLAN/issue alignment, including explicit non-goals and dependency owner boundaries.
- Tests, fixtures, E2E evidence, CI status, and reviewer reproducibility.
- Secret handling, auth boundaries, sanitization, auditability, rollback behavior, and observable failure paths.
- Docs consistency, especially when commands, assets, configuration, public contracts, or release gates changed.
- Supervisor handoff quality: each valid finding must include a concrete `suggested_fix` that a `supervisor` can accept or reject without reinterpreting the whole review.

## Output
Return only the configured `review` prompt_contract YAML.

For `status=completed`, `data.findings` must be an array. Use an empty array when there are no high-signal findings.

Each finding must contain:
- `severity`: one of `P0`, `P1`, `P2`, or `P3`.
- `file`: repo-relative path.
- `line`: positive integer or null when no single line applies.
- `title`: concise issue title.
- `rationale`: concrete failure mode, impact, and evidence.
- `suggested_fix`: smallest required correction for supervisor/fix handoff.

Order findings by severity, then by impact. Do not include raw secrets in rationale or suggested fixes.
