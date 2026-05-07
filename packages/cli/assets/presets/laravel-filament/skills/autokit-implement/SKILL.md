---
name: autokit-implement
description: Use for Laravel / Filament implementation and fix phases.
---

# autokit-implement

Use this skill for `implement` and `fix` phases.

## Rules
- Read the issue, plan, SSOT, migrations, policies, resources, and relevant tests before editing.
- Prefer Laravel and Filament conventions over custom abstractions.
- Add or update focused tests for behavior, validation, authorization, and migrations when touched.
- Never expose secrets, read provider auth files, or run live provider calls without explicit approval.
- Return the configured prompt contract YAML with changed files, validation, and residual risks.
