---
name: autokit-implement
description: Use for autokit implement and fix phases that must edit issue-scoped code and return the configured prompt contract.
---

# autokit-implement

Use this skill for `implement` and `fix` phases.

Source alignment: adapted from `tdd-workflow` at commit `866d9ebb5364a579ac7d2a8fb79bb421bf9d7052` for autokit prompt_contract phases.

## Inputs
- Read the issue, current plan, blocked-by status, SPEC/PLAN references, relevant code/tests, and current diff before editing.
- Treat the verified plan and issue scope as the write boundary. If they conflict, pause through `autokit-question` instead of guessing.
- Use repository conventions and the active worktree only. Do not change adjacent issue owners, agents, or prompt schemas unless the issue explicitly owns them.

## TDD Flow
- RED: add or update the smallest relevant failing test for behavior changes, bug fixes, migrations, command behavior, prompt_contract gates, or asset validation.
- GREEN: implement the minimum issue-scoped change needed to pass the RED test.
- REFACTOR: simplify names, duplication, and ownership boundaries while keeping the same focused test target green.
- If a test-first path is not practical, record the reason in `data.notes` and provide equivalent observable validation in `data.tests_run`.

## Safety
- Never expose secrets, read provider auth files, or copy token-like values into code, logs, prompts, issues, or PR text.
- Do not run live provider calls, SDK matrices, high-count matrices, or paid-risk-gated experiments unless the operator explicitly approves them.
- Keep failures observable. Do not hide failed checks with silent fallbacks, skipped gates, or unverified success claims.
- Do not run git rebase, merge, push, PR, or cleanup commands. Core owns base sync, git/gh mutations, checkpoints, and cleanup; this skill only edits assigned worktree files and reports conflicts through the prompt_contract.
- Delegate documentation updates to `doc-updater` when code changes alter documented behavior, commands, assets, configuration, safety rules, or release gates.

## Output
Return only the configured `prompt_contract` YAML for the current phase.

For `implement`, `data` must contain:
- `changed_files`: repo-relative paths touched by this phase.
- `tests_run`: exact commands with `result` and short evidence summary.
- `docs_updated`: boolean indicating whether docs were updated.
- `notes`: concise outcome, residual risks, and any skipped checks with reasons.

For `fix`, `data` must contain:
- `changed_files`
- `tests_run`
- `resolved_accept_ids`
- `unresolved_accept_ids`
- `notes`

Use `status=need_input` through `autokit-question` when requirements are conflicting, blocked, destructive, production-impacting, outside scope, or not safely verifiable.
