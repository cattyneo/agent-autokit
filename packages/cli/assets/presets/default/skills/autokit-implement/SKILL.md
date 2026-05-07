---
name: autokit-implement
description: Use for default preset implementation and fix phases.
---

# autokit-implement

Use this skill for `implement` and `fix` phases.

## Rules
- Read the issue, plan, SSOT, dependencies, and current diff before editing.
- Keep changes scoped to the selected issue and existing repository conventions.
- Put behavior changes behind focused tests first when practical.
- Never expose secrets, read provider auth files, or run live provider calls without explicit approval.
- Return the configured prompt contract YAML with changed files, validation, and residual risks.
