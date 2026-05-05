# AGENTS.md

## Context

- Reply in Japanese when working with the primary maintainer.
- Environment target: Apple Silicon macOS.
- v0.1.0 is a private distribution MVP for fixture-like repositories.

## Safety

- Do not read `~/.codex/auth.json` or `$CODEX_HOME/auth.json`.
- Do not run live provider workflows while `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `CODEX_API_KEY` are set.
- Do not run high-count matrices, SDK matrices, or paid-risk-gated experiments without explicit approval.
- Keep `packages/cli/package.json` `private: true`; registry publish is out of scope.

## Workflow

- Read the relevant Issue, `docs/SPEC.md`, `docs/PLAN.md`, and existing artifacts before implementing.
- Prefer small PRs that close one issue or one clearly split blocker.
- For release work, keep environment preflight, artifact generation, install smoke, and GitHub Release evidence explicit and reproducible.
- After implementation, run the smallest relevant checks first, then the full required gates before handoff.

## Verification

Common gates:

```bash
bun run lint
bun run typecheck
bun test
bun run build
/bin/bash scripts/check-assets-hygiene.sh
```

Use `/bin/bash` for `scripts/check-assets-hygiene.sh` on macOS if Homebrew bash stalls on command-substitution here-strings.
