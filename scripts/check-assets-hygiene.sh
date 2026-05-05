#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_PACKAGE="$ROOT_DIR/packages/cli/package.json"

private_value="$(node -p "require(process.argv[1]).private === true ? 'true' : 'false'" "$CLI_PACKAGE")"
if [ "$private_value" != "true" ]; then
  echo "::error file=packages/cli/package.json::packages/cli must remain private:true"
  exit 1
fi

if [ ! -d "$ROOT_DIR/packages/cli/dist" ]; then
  echo "::error file=packages/cli::packages/cli/dist is missing; run bun run build first"
  exit 1
fi

pack_output="$(cd "$ROOT_DIR/packages/cli" && bun pm pack --dry-run 2>&1)"
printf '%s\n' "$pack_output"

npm_pack_output="$(cd "$ROOT_DIR/packages/cli" && npm --cache "${AUTOKIT_NPM_CACHE:-/tmp/autokit-npm-cache}" pack --dry-run 2>&1)"
printf '%s\n' "$npm_pack_output"

violations=0
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

if grep --line-number -E "@cattyneo/autokit-(core|workflows|claude-runner|codex-runner|tui)" "$CLI_PACKAGE" "${publish_js[@]}" >/tmp/autokit-private-import-grep.txt 2>/dev/null; then
  cat /tmp/autokit-private-import-grep.txt
  echo "::error::publish candidate contains unresolved private workspace import"
  exit 1
fi

echo "assets hygiene passed"
