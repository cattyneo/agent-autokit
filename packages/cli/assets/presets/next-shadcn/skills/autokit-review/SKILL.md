---
name: autokit-review
description: Use for Next.js / shadcn/ui review phases.
---

# autokit-review

Use this skill for `review` phases.

Source alignment: adapted from local `general-review` source fingerprint `sha256:b95eddbaa3e3c671c657084d8919a0a34d031dec60a6228d08158514a742d7f5` for autokit prompt_contract review phases.

## Review Mode
- Stay read-only. Do not edit files, run destructive commands, push branches, merge PRs, or mutate GitHub state.
- Use `autokit-question` when key evidence is missing or the review cannot be completed safely.

## Review Focus
- App Router conventions, server/client component boundaries, accessibility, responsive layout, and tests.
- Issue acceptance criteria, SSOT alignment, and scope boundaries.
- Secret handling, auth boundaries, sanitization, auditability, and rollback behavior.
- Reproducible validation evidence.
- supervisor handoff quality: include concrete `suggested_fix` guidance for each valid finding.

## Output
Return only the configured `review` prompt_contract YAML. For `status=completed`, `data.findings` must contain objects with `severity` (`P0` / `P1` / `P2` / `P3`), `file`, `line`, `title`, `rationale`, and `suggested_fix`.
