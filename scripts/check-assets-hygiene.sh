#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_PACKAGE="$ROOT_DIR/packages/cli/package.json"

if [ -n "${BUN_BIN:-}" ]; then
  BUN_CMD=("$BUN_BIN")
elif command -v bun >/dev/null 2>&1; then
  BUN_CMD=(bun)
else
  BUN_CMD=(npx --yes bun@1.3.13)
fi

private_value="$(node -p "require(process.argv[1]).private === true ? 'true' : 'false'" "$CLI_PACKAGE")"
if [ "$private_value" != "true" ]; then
  echo "::error file=packages/cli/package.json::packages/cli must remain private:true"
  exit 1
fi

if [ ! -d "$ROOT_DIR/packages/cli/dist" ]; then
  echo "::error file=packages/cli::packages/cli/dist is missing; run bun run build first"
  exit 1
fi

if [ -n "${AUTOKIT_ASSETS_HYGIENE_BUN_PACK_OUTPUT_FILE:-}" ]; then
  pack_output="$(cat "$AUTOKIT_ASSETS_HYGIENE_BUN_PACK_OUTPUT_FILE")"
else
  pack_output="$(cd "$ROOT_DIR/packages/cli" && "${BUN_CMD[@]}" pm pack --dry-run 2>&1)"
fi
printf '%s\n' "$pack_output"

if [ -n "${AUTOKIT_ASSETS_HYGIENE_NPM_PACK_OUTPUT_FILE:-}" ]; then
  npm_pack_output="$(cat "$AUTOKIT_ASSETS_HYGIENE_NPM_PACK_OUTPUT_FILE")"
else
  npm_pack_output="$(cd "$ROOT_DIR/packages/cli" && npm --cache "${AUTOKIT_NPM_CACHE:-/tmp/autokit-npm-cache}" pack --dry-run 2>&1)"
fi
printf '%s\n' "$npm_pack_output"

violations=0
required_bun_entries=(
  "assets/presets/default/config.yaml"
  "assets/presets/default/skills/autokit-implement/SKILL.md"
  "assets/presets/laravel-filament/config.yaml"
  "assets/presets/laravel-filament/skills/autokit-review/SKILL.md"
  "assets/presets/next-shadcn/config.yaml"
  "assets/presets/next-shadcn/prompts/implement.md"
  "assets/presets/docs-create/config.yaml"
  "assets/presets/docs-create/agents/reviewer.md"
)

for entry in "${required_bun_entries[@]}"; do
  if ! grep -F -- "$entry" <<< "$pack_output" >/dev/null; then
    echo "::error::required bun pack entry missing: $entry"
    violations=$((violations + 1))
  fi
done

while IFS= read -r entry; do
  case "$entry" in
    *__MACOSX*|*.DS_Store*|*.claude/state*|*.claude/sessions*|*.claude/credentials*|*.codex/auth*|*.codex/credentials*|*.env|*.env.*|*.pem|*id_rsa*)
      echo "::error::forbidden publish candidate entry: $entry"
      violations=$((violations + 1))
      ;;
  esac
done <<< "$pack_output"$'\n'"$npm_pack_output"

if [ "$violations" -gt 0 ]; then
  exit 1
fi

publish_js=("$ROOT_DIR/packages/cli/dist/bin.js")

if grep --line-number --fixed-strings "workspace:" "$CLI_PACKAGE" "${publish_js[@]}" >/tmp/autokit-workspace-grep.txt 2>/dev/null; then
  cat /tmp/autokit-workspace-grep.txt
  echo "::error::publish candidate contains workspace: specifier"
  exit 1
fi

if grep --line-number -E "@cattyneo/autokit-(core|workflows|claude-runner|codex-runner|tui|serve)" "$CLI_PACKAGE" "${publish_js[@]}" >/tmp/autokit-private-import-grep.txt 2>/dev/null; then
  cat /tmp/autokit-private-import-grep.txt
  echo "::error::publish candidate contains unresolved private workspace import"
  exit 1
fi

echo "assets hygiene passed"
