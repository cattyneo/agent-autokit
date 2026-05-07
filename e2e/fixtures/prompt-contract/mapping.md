# Prompt Contract Mapping

This table maps each bundled prompt section to the structured prompt_contract field it supports.

| prompt_contract | field | md_section | prompt_file | preset_effective_prompt |
|---|---|---|---|---|
| plan | data.plan_markdown | ## Result | packages/cli/assets/prompts/plan.md | base |
| plan | data.assumptions | ## Evidence | packages/cli/assets/prompts/plan.md | base |
| plan | data.plan_markdown | ## Changes | packages/cli/assets/prompts/plan.md | base |
| plan | data.risks | ## Test results | packages/cli/assets/prompts/plan.md | base |
| plan-verify | data.result | ## Result | packages/cli/assets/prompts/plan-verify.md | base |
| plan-verify | data.findings[].rationale | ## Evidence | packages/cli/assets/prompts/plan-verify.md | base |
| plan-verify | data.findings[].required_change | ## Changes | packages/cli/assets/prompts/plan-verify.md | base |
| plan-verify | data.findings | ## Test results | packages/cli/assets/prompts/plan-verify.md | base |
| plan-fix | data.plan_markdown | ## Result | packages/cli/assets/prompts/plan-fix.md | base |
| plan-fix | data.addressed_findings | ## Evidence | packages/cli/assets/prompts/plan-fix.md | base |
| plan-fix | data.plan_markdown | ## Changes | packages/cli/assets/prompts/plan-fix.md | base |
| plan-fix | data.addressed_findings | ## Test results | packages/cli/assets/prompts/plan-fix.md | base |
| implement | data.notes | ## Result | packages/cli/assets/prompts/implement.md | base |
| implement | data.notes | ## Evidence | packages/cli/assets/prompts/implement.md | base |
| implement | data.changed_files | ## Changes | packages/cli/assets/prompts/implement.md | base |
| implement | data.tests_run | ## Test results | packages/cli/assets/prompts/implement.md | base |
| review | data.findings[].title | ## Result | packages/cli/assets/prompts/review.md | base |
| review | data.findings[].rationale | ## Evidence | packages/cli/assets/prompts/review.md | base |
| review | data.findings[].suggested_fix | ## Changes | packages/cli/assets/prompts/review.md | base |
| review | data.findings | ## Test results | packages/cli/assets/prompts/review.md | base |
| supervise | data.accept_ids / data.reject_ids | ## Result | packages/cli/assets/prompts/supervise.md | base |
| supervise | data.reject_reasons | ## Evidence | packages/cli/assets/prompts/supervise.md | base |
| supervise | data.fix_prompt | ## Changes | packages/cli/assets/prompts/supervise.md | base |
| supervise | data.reject_reasons | ## Test results | packages/cli/assets/prompts/supervise.md | base |
| fix | data.notes | ## Result | packages/cli/assets/prompts/fix.md | base |
| fix | data.notes | ## Evidence | packages/cli/assets/prompts/fix.md | base |
| fix | data.changed_files / data.resolved_accept_ids | ## Changes | packages/cli/assets/prompts/fix.md | base |
| fix | data.tests_run | ## Test results | packages/cli/assets/prompts/fix.md | base |
