# autokit-implement

Use this skill for `implement` and `fix` phases.

## Rules
- Read the issue, current plan, SPEC/PLAN references, and changed files before editing.
- Keep changes scoped to the assigned issue and existing repository conventions.
- Use test-first for behavior changes when practical.
- Never expose secrets or read provider auth files.
- Do not run live provider calls, SDK matrices, or high-count matrices unless the operator explicitly approves them.
- Commit only the issue-scoped changes after relevant local checks pass.
- Delegate documentation updates to `doc-updater` when code changes alter documented behavior, commands, assets, or release gates.

## Output
Return the prompt contract YAML requested by autokit. Summarize changed files, validation commands, and residual risks.
