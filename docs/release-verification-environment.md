# Release Verification Environment

This runbook is the AK-019 preflight for v0.1.0 private release verification. It prepares a separate machine or clean HOME for AK-020 without generating the release tarball, installing it, or creating a GitHub Release.

## Scope

- Confirm host/tool prerequisites for Apple Silicon macOS.
- Confirm subscription CLI auth is available through `claude` and `codex` commands without API key environment variables.
- Confirm GitHub auth and fixture repository permissions.
- Define the two install paths that AK-020 will verify: release tarball install and `bun link`.

## Non-goals

- Do not run `bun pm pack` to create a release artifact.
- Do not run `npm i -g <tarball>` or `bun link` smoke.
- Do not create or mutate fixture PRs, Issues, branch protection, tags, or GitHub Releases.
- Do not read `~/.codex/auth.json` or `$CODEX_HOME/auth.json`.

## Preconditions

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `CODEX_API_KEY` are unset.
- `node`, `bun`, `gh`, `claude`, and `codex` are on `PATH`.
- `gh auth status -h github.com` succeeds with `repo` and `workflow` scopes.
- The GitHub user has write/admin permission to:
  - `cattyneo/agent-autokit-e2e-fixture`
  - `cattyneo/agent-autokit-e2e-fixture-protected`
- The protected fixture branch protection is restored to required status check `test` only before AK-020 begins.

## Clean HOME Shape

For AK-020, prefer a separate macOS user or another Apple Silicon macOS machine. If that is not available, use an isolated HOME/XDG root for install smoke only:

```bash
export AUTOKIT_RELEASE_HOME="$(mktemp -d /tmp/autokit-release-home.XXXXXX)"
export HOME="$AUTOKIT_RELEASE_HOME/home"
export XDG_CONFIG_HOME="$AUTOKIT_RELEASE_HOME/config"
export XDG_CACHE_HOME="$AUTOKIT_RELEASE_HOME/cache"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
```

Do not copy provider auth files into the artifact bundle. Subscription login may be established interactively by the human operator before AK-020 smoke, but API key environment variables must remain unset.

## Preflight Command

Run the preflight from the repository root:

```bash
PATH="$HOME/.bun/bin:$PATH" scripts/check-release-verification-env.sh
```

The script prints host/tool versions, API key guard status, GitHub auth status, fixture permissions, and protected fixture branch-protection state. It is read-only except for normal CLI auth/status reads performed by `gh`, `claude`, and `codex`.

## AK-020 Handoff

AK-020 should use this environment to run both supported private distribution paths:

- release tarball path: `npm i -g <tarball>` followed by `autokit doctor` and a release smoke
- checkout path: `bun link` followed by the same doctor/smoke checks

AK-020 remains responsible for the release tarball, GitHub Release, release notes, and clean HOME smoke log.
