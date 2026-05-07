---
name: autokit-implement
description: Use for documentation-first implementation and fix phases.
---

# autokit-implement

Use this skill for `implement` and `fix` phases.

## Rules
- Read the issue, plan, SSOT, existing docs, and affected commands before editing.
- Keep docs concise, internally consistent, and grounded in verified behavior.
- Run relevant doc, lint, link, or command validation when available.
- Never expose secrets, read provider auth files, or run live provider calls without explicit approval.
- Return the configured prompt contract YAML with changed files, validation, and residual risks.
