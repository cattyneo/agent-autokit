---
name: autokit-question
description: Defines the single status=need_input response contract for autokit prompts.
---

# Autokit Question

Use this skill when an autokit prompt needs user input.

Return exactly one question through the prompt_contract output:

- `status`: `need_input`
- `summary`: short reason for the question
- `question.text`: one sentence
- `question.default`: required fallback answer

Do not ask through stdin/stdout. Multiple questions must be split into separate turns.
