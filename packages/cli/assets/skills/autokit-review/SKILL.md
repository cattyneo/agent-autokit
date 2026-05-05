# autokit-review

Use this skill for `review` phases.

## Review Focus
- Correctness, regressions, missing tests, and unsafe assumptions.
- SPEC/PLAN/issue alignment, including explicit out-of-scope work.
- Secret handling, auth boundaries, sanitization, auditability, and rollback behavior.
- CI, local validation evidence, and reviewer reproducibility.

## Output
Return findings first, ordered by severity. Use file and line references when possible. If there are no findings, say so and list remaining test gaps or risks.
