# AK-002-FIXTURE runner visibility issue input

## Goal

Verify that provider-visible skill and agent paths resolve through `.agents` and that prompt templates can refer to the bundled `autokit-question` skill.

## Expected runner behavior

- Claude reads `.claude/skills` and `.claude/agents`, both symlinked into `.agents`.
- Codex reads `.codex/skills` and `.codex/agents`, both symlinked into `.agents`.
- If the agent needs clarification, it must return `status=need_input` using the `autokit-question` contract.

## Fixed question scenario

The fixture intentionally leaves the test framework unspecified. If a runner needs to ask, the default answer is `node:test`.
