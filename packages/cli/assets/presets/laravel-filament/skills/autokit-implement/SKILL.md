---
name: autokit-implement
description: Use for Laravel / Filament implementation and fix phases.
---

# autokit-implement

Use this skill for `implement` and `fix` phases.

Source alignment: adapted from `tdd-workflow` at commit `866d9ebb5364a579ac7d2a8fb79bb421bf9d7052` for autokit prompt_contract phases.

## Rules
- Read the issue, plan, SSOT, migrations, policies, resources, relevant tests, and current diff before editing.
- Prefer Laravel and Filament conventions over custom abstractions.
- Use RED / GREEN / REFACTOR for behavior, validation, authorization, and migration changes when practical.
- Never expose secrets, read provider auth files, or run live provider calls without explicit approval.
- Do not run git rebase, merge, push, PR, or cleanup commands. Core owns git/gh mutations and checkpoints.
- Delegate docs-affecting updates to `doc-updater`.

## Output
Return only the configured `prompt_contract` YAML.

For `implement`, `data` must include `changed_files`, `tests_run`, `docs_updated`, and `notes`.
For `fix`, `data` must include `changed_files`, `tests_run`, `resolved_accept_ids`, `unresolved_accept_ids`, and `notes`.
Use `autokit-question` for unsafe or blocked `status=need_input` cases.
