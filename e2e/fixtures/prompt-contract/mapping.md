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
| plan | data.plan_markdown | ## Result | packages/cli/assets/prompts/plan.md | preset:default/prompts/plan.md |
| plan | data.assumptions | ## Evidence | packages/cli/assets/prompts/plan.md | preset:default/prompts/plan.md |
| plan | data.plan_markdown | ## Changes | packages/cli/assets/prompts/plan.md | preset:default/prompts/plan.md |
| plan | data.risks | ## Test results | packages/cli/assets/prompts/plan.md | preset:default/prompts/plan.md |
| plan-verify | data.result | ## Result | packages/cli/assets/prompts/plan-verify.md | preset:default/prompts/plan-verify.md |
| plan-verify | data.findings[].rationale | ## Evidence | packages/cli/assets/prompts/plan-verify.md | preset:default/prompts/plan-verify.md |
| plan-verify | data.findings[].required_change | ## Changes | packages/cli/assets/prompts/plan-verify.md | preset:default/prompts/plan-verify.md |
| plan-verify | data.findings | ## Test results | packages/cli/assets/prompts/plan-verify.md | preset:default/prompts/plan-verify.md |
| plan-fix | data.plan_markdown | ## Result | packages/cli/assets/prompts/plan-fix.md | preset:default/prompts/plan-fix.md |
| plan-fix | data.addressed_findings | ## Evidence | packages/cli/assets/prompts/plan-fix.md | preset:default/prompts/plan-fix.md |
| plan-fix | data.plan_markdown | ## Changes | packages/cli/assets/prompts/plan-fix.md | preset:default/prompts/plan-fix.md |
| plan-fix | data.addressed_findings | ## Test results | packages/cli/assets/prompts/plan-fix.md | preset:default/prompts/plan-fix.md |
| implement | data.notes | ## Result | packages/cli/assets/prompts/implement.md | preset:default/prompts/implement.md |
| implement | data.notes | ## Evidence | packages/cli/assets/prompts/implement.md | preset:default/prompts/implement.md |
| implement | data.changed_files | ## Changes | packages/cli/assets/prompts/implement.md | preset:default/prompts/implement.md |
| implement | data.tests_run | ## Test results | packages/cli/assets/prompts/implement.md | preset:default/prompts/implement.md |
| review | data.findings[].title | ## Result | packages/cli/assets/prompts/review.md | preset:default/prompts/review.md |
| review | data.findings[].rationale | ## Evidence | packages/cli/assets/prompts/review.md | preset:default/prompts/review.md |
| review | data.findings[].suggested_fix | ## Changes | packages/cli/assets/prompts/review.md | preset:default/prompts/review.md |
| review | data.findings | ## Test results | packages/cli/assets/prompts/review.md | preset:default/prompts/review.md |
| supervise | data.accept_ids / data.reject_ids | ## Result | packages/cli/assets/prompts/supervise.md | preset:default/prompts/supervise.md |
| supervise | data.reject_reasons | ## Evidence | packages/cli/assets/prompts/supervise.md | preset:default/prompts/supervise.md |
| supervise | data.fix_prompt | ## Changes | packages/cli/assets/prompts/supervise.md | preset:default/prompts/supervise.md |
| supervise | data.reject_reasons | ## Test results | packages/cli/assets/prompts/supervise.md | preset:default/prompts/supervise.md |
| fix | data.notes | ## Result | packages/cli/assets/prompts/fix.md | preset:default/prompts/fix.md |
| fix | data.notes | ## Evidence | packages/cli/assets/prompts/fix.md | preset:default/prompts/fix.md |
| fix | data.changed_files / data.resolved_accept_ids | ## Changes | packages/cli/assets/prompts/fix.md | preset:default/prompts/fix.md |
| fix | data.tests_run | ## Test results | packages/cli/assets/prompts/fix.md | preset:default/prompts/fix.md |
| plan | data.plan_markdown | ## Result | packages/cli/assets/prompts/plan.md | preset:laravel-filament/prompts/plan.md |
| plan | data.assumptions | ## Evidence | packages/cli/assets/prompts/plan.md | preset:laravel-filament/prompts/plan.md |
| plan | data.plan_markdown | ## Changes | packages/cli/assets/prompts/plan.md | preset:laravel-filament/prompts/plan.md |
| plan | data.risks | ## Test results | packages/cli/assets/prompts/plan.md | preset:laravel-filament/prompts/plan.md |
| plan-verify | data.result | ## Result | packages/cli/assets/prompts/plan-verify.md | preset:laravel-filament/prompts/plan-verify.md |
| plan-verify | data.findings[].rationale | ## Evidence | packages/cli/assets/prompts/plan-verify.md | preset:laravel-filament/prompts/plan-verify.md |
| plan-verify | data.findings[].required_change | ## Changes | packages/cli/assets/prompts/plan-verify.md | preset:laravel-filament/prompts/plan-verify.md |
| plan-verify | data.findings | ## Test results | packages/cli/assets/prompts/plan-verify.md | preset:laravel-filament/prompts/plan-verify.md |
| plan-fix | data.plan_markdown | ## Result | packages/cli/assets/prompts/plan-fix.md | preset:laravel-filament/prompts/plan-fix.md |
| plan-fix | data.addressed_findings | ## Evidence | packages/cli/assets/prompts/plan-fix.md | preset:laravel-filament/prompts/plan-fix.md |
| plan-fix | data.plan_markdown | ## Changes | packages/cli/assets/prompts/plan-fix.md | preset:laravel-filament/prompts/plan-fix.md |
| plan-fix | data.addressed_findings | ## Test results | packages/cli/assets/prompts/plan-fix.md | preset:laravel-filament/prompts/plan-fix.md |
| implement | data.notes | ## Result | packages/cli/assets/prompts/implement.md | preset:laravel-filament/prompts/implement.md |
| implement | data.notes | ## Evidence | packages/cli/assets/prompts/implement.md | preset:laravel-filament/prompts/implement.md |
| implement | data.changed_files | ## Changes | packages/cli/assets/prompts/implement.md | preset:laravel-filament/prompts/implement.md |
| implement | data.tests_run | ## Test results | packages/cli/assets/prompts/implement.md | preset:laravel-filament/prompts/implement.md |
| review | data.findings[].title | ## Result | packages/cli/assets/prompts/review.md | preset:laravel-filament/prompts/review.md |
| review | data.findings[].rationale | ## Evidence | packages/cli/assets/prompts/review.md | preset:laravel-filament/prompts/review.md |
| review | data.findings[].suggested_fix | ## Changes | packages/cli/assets/prompts/review.md | preset:laravel-filament/prompts/review.md |
| review | data.findings | ## Test results | packages/cli/assets/prompts/review.md | preset:laravel-filament/prompts/review.md |
| supervise | data.accept_ids / data.reject_ids | ## Result | packages/cli/assets/prompts/supervise.md | preset:laravel-filament/prompts/supervise.md |
| supervise | data.reject_reasons | ## Evidence | packages/cli/assets/prompts/supervise.md | preset:laravel-filament/prompts/supervise.md |
| supervise | data.fix_prompt | ## Changes | packages/cli/assets/prompts/supervise.md | preset:laravel-filament/prompts/supervise.md |
| supervise | data.reject_reasons | ## Test results | packages/cli/assets/prompts/supervise.md | preset:laravel-filament/prompts/supervise.md |
| fix | data.notes | ## Result | packages/cli/assets/prompts/fix.md | preset:laravel-filament/prompts/fix.md |
| fix | data.notes | ## Evidence | packages/cli/assets/prompts/fix.md | preset:laravel-filament/prompts/fix.md |
| fix | data.changed_files / data.resolved_accept_ids | ## Changes | packages/cli/assets/prompts/fix.md | preset:laravel-filament/prompts/fix.md |
| fix | data.tests_run | ## Test results | packages/cli/assets/prompts/fix.md | preset:laravel-filament/prompts/fix.md |
| plan | data.plan_markdown | ## Result | packages/cli/assets/prompts/plan.md | preset:next-shadcn/prompts/plan.md |
| plan | data.assumptions | ## Evidence | packages/cli/assets/prompts/plan.md | preset:next-shadcn/prompts/plan.md |
| plan | data.plan_markdown | ## Changes | packages/cli/assets/prompts/plan.md | preset:next-shadcn/prompts/plan.md |
| plan | data.risks | ## Test results | packages/cli/assets/prompts/plan.md | preset:next-shadcn/prompts/plan.md |
| plan-verify | data.result | ## Result | packages/cli/assets/prompts/plan-verify.md | preset:next-shadcn/prompts/plan-verify.md |
| plan-verify | data.findings[].rationale | ## Evidence | packages/cli/assets/prompts/plan-verify.md | preset:next-shadcn/prompts/plan-verify.md |
| plan-verify | data.findings[].required_change | ## Changes | packages/cli/assets/prompts/plan-verify.md | preset:next-shadcn/prompts/plan-verify.md |
| plan-verify | data.findings | ## Test results | packages/cli/assets/prompts/plan-verify.md | preset:next-shadcn/prompts/plan-verify.md |
| plan-fix | data.plan_markdown | ## Result | packages/cli/assets/prompts/plan-fix.md | preset:next-shadcn/prompts/plan-fix.md |
| plan-fix | data.addressed_findings | ## Evidence | packages/cli/assets/prompts/plan-fix.md | preset:next-shadcn/prompts/plan-fix.md |
| plan-fix | data.plan_markdown | ## Changes | packages/cli/assets/prompts/plan-fix.md | preset:next-shadcn/prompts/plan-fix.md |
| plan-fix | data.addressed_findings | ## Test results | packages/cli/assets/prompts/plan-fix.md | preset:next-shadcn/prompts/plan-fix.md |
| implement | data.notes | ## Result | packages/cli/assets/prompts/implement.md | preset:next-shadcn/prompts/implement.md |
| implement | data.notes | ## Evidence | packages/cli/assets/prompts/implement.md | preset:next-shadcn/prompts/implement.md |
| implement | data.changed_files | ## Changes | packages/cli/assets/prompts/implement.md | preset:next-shadcn/prompts/implement.md |
| implement | data.tests_run | ## Test results | packages/cli/assets/prompts/implement.md | preset:next-shadcn/prompts/implement.md |
| review | data.findings[].title | ## Result | packages/cli/assets/prompts/review.md | preset:next-shadcn/prompts/review.md |
| review | data.findings[].rationale | ## Evidence | packages/cli/assets/prompts/review.md | preset:next-shadcn/prompts/review.md |
| review | data.findings[].suggested_fix | ## Changes | packages/cli/assets/prompts/review.md | preset:next-shadcn/prompts/review.md |
| review | data.findings | ## Test results | packages/cli/assets/prompts/review.md | preset:next-shadcn/prompts/review.md |
| supervise | data.accept_ids / data.reject_ids | ## Result | packages/cli/assets/prompts/supervise.md | preset:next-shadcn/prompts/supervise.md |
| supervise | data.reject_reasons | ## Evidence | packages/cli/assets/prompts/supervise.md | preset:next-shadcn/prompts/supervise.md |
| supervise | data.fix_prompt | ## Changes | packages/cli/assets/prompts/supervise.md | preset:next-shadcn/prompts/supervise.md |
| supervise | data.reject_reasons | ## Test results | packages/cli/assets/prompts/supervise.md | preset:next-shadcn/prompts/supervise.md |
| fix | data.notes | ## Result | packages/cli/assets/prompts/fix.md | preset:next-shadcn/prompts/fix.md |
| fix | data.notes | ## Evidence | packages/cli/assets/prompts/fix.md | preset:next-shadcn/prompts/fix.md |
| fix | data.changed_files / data.resolved_accept_ids | ## Changes | packages/cli/assets/prompts/fix.md | preset:next-shadcn/prompts/fix.md |
| fix | data.tests_run | ## Test results | packages/cli/assets/prompts/fix.md | preset:next-shadcn/prompts/fix.md |
| plan | data.plan_markdown | ## Result | packages/cli/assets/prompts/plan.md | preset:docs-create/prompts/plan.md |
| plan | data.assumptions | ## Evidence | packages/cli/assets/prompts/plan.md | preset:docs-create/prompts/plan.md |
| plan | data.plan_markdown | ## Changes | packages/cli/assets/prompts/plan.md | preset:docs-create/prompts/plan.md |
| plan | data.risks | ## Test results | packages/cli/assets/prompts/plan.md | preset:docs-create/prompts/plan.md |
| plan-verify | data.result | ## Result | packages/cli/assets/prompts/plan-verify.md | preset:docs-create/prompts/plan-verify.md |
| plan-verify | data.findings[].rationale | ## Evidence | packages/cli/assets/prompts/plan-verify.md | preset:docs-create/prompts/plan-verify.md |
| plan-verify | data.findings[].required_change | ## Changes | packages/cli/assets/prompts/plan-verify.md | preset:docs-create/prompts/plan-verify.md |
| plan-verify | data.findings | ## Test results | packages/cli/assets/prompts/plan-verify.md | preset:docs-create/prompts/plan-verify.md |
| plan-fix | data.plan_markdown | ## Result | packages/cli/assets/prompts/plan-fix.md | preset:docs-create/prompts/plan-fix.md |
| plan-fix | data.addressed_findings | ## Evidence | packages/cli/assets/prompts/plan-fix.md | preset:docs-create/prompts/plan-fix.md |
| plan-fix | data.plan_markdown | ## Changes | packages/cli/assets/prompts/plan-fix.md | preset:docs-create/prompts/plan-fix.md |
| plan-fix | data.addressed_findings | ## Test results | packages/cli/assets/prompts/plan-fix.md | preset:docs-create/prompts/plan-fix.md |
| implement | data.notes | ## Result | packages/cli/assets/prompts/implement.md | preset:docs-create/prompts/implement.md |
| implement | data.notes | ## Evidence | packages/cli/assets/prompts/implement.md | preset:docs-create/prompts/implement.md |
| implement | data.changed_files | ## Changes | packages/cli/assets/prompts/implement.md | preset:docs-create/prompts/implement.md |
| implement | data.tests_run | ## Test results | packages/cli/assets/prompts/implement.md | preset:docs-create/prompts/implement.md |
| review | data.findings[].title | ## Result | packages/cli/assets/prompts/review.md | preset:docs-create/prompts/review.md |
| review | data.findings[].rationale | ## Evidence | packages/cli/assets/prompts/review.md | preset:docs-create/prompts/review.md |
| review | data.findings[].suggested_fix | ## Changes | packages/cli/assets/prompts/review.md | preset:docs-create/prompts/review.md |
| review | data.findings | ## Test results | packages/cli/assets/prompts/review.md | preset:docs-create/prompts/review.md |
| supervise | data.accept_ids / data.reject_ids | ## Result | packages/cli/assets/prompts/supervise.md | preset:docs-create/prompts/supervise.md |
| supervise | data.reject_reasons | ## Evidence | packages/cli/assets/prompts/supervise.md | preset:docs-create/prompts/supervise.md |
| supervise | data.fix_prompt | ## Changes | packages/cli/assets/prompts/supervise.md | preset:docs-create/prompts/supervise.md |
| supervise | data.reject_reasons | ## Test results | packages/cli/assets/prompts/supervise.md | preset:docs-create/prompts/supervise.md |
| fix | data.notes | ## Result | packages/cli/assets/prompts/fix.md | preset:docs-create/prompts/fix.md |
| fix | data.notes | ## Evidence | packages/cli/assets/prompts/fix.md | preset:docs-create/prompts/fix.md |
| fix | data.changed_files / data.resolved_accept_ids | ## Changes | packages/cli/assets/prompts/fix.md | preset:docs-create/prompts/fix.md |
| fix | data.tests_run | ## Test results | packages/cli/assets/prompts/fix.md | preset:docs-create/prompts/fix.md |
