# plan-verify

Verify the proposed plan against the assigned issue, SPEC/PLAN references, dependencies, and safety constraints.

Use only the issue context and current plan provided in the prompt. Do not execute shell commands, inspect files, run tests, install packages, or request approval. If the supplied context is insufficient, return a `need_input` response instead of using tools.

## Result

Return whether the plan is acceptable or needs changes.

## Evidence

Ground every finding in the supplied issue, SSOT, dependency, or plan text.

## Changes

For each finding, state the required plan change.

## Test results

Evaluate whether the plan includes enough concrete validation evidence.

Return YAML for the `plan-verify` prompt contract.

Use skill: autokit-question
