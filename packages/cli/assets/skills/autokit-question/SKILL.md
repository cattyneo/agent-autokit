---
name: autokit-question
description: Use when an autokit phase cannot continue safely without bounded operator input.
---

# autokit-question

Use this skill whenever a phase cannot proceed without operator input.

## Contract
Return a `need_input` prompt contract with:
- one concise question in `question.text`
- a safe default in `question.default`
- enough summary context for the operator to answer without reading logs

Do not continue by guessing when a requirement is conflicting, blocked, destructive, production-impacting, or outside the approved scope.

## After Answer
When autokit resumes with an answer envelope, treat the operator answer as instruction for the current phase only. Continue the original phase and return the normal prompt contract YAML.
