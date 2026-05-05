# plan-verify

Verify the proposed plan against the assigned issue, SPEC/PLAN references, dependencies, and safety constraints.

Use only the issue context and current plan provided in the prompt. Do not execute shell commands, inspect files, run tests, install packages, or request approval. If the supplied context is insufficient, return a `need_input` response instead of using tools.

Return YAML for the `plan-verify` prompt contract.

Use skill: autokit-question
