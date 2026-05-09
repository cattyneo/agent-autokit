#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$ROOT_DIR/packages/cli"
CLI_PACKAGE="$CLI_DIR/package.json"
NODE_BIN="${NODE_BIN:-node}"
RELEASE_DIR="${AUTOKIT_RELEASE_DIR:-$ROOT_DIR/dist/release}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: missing required command: $1" >&2
    exit 1
  fi
}

require_cmd "$NODE_BIN"
require_cmd /bin/bash
if [ -n "${BUN_BIN:-}" ]; then
  BUN_CMD=("$BUN_BIN")
elif command -v bun >/dev/null 2>&1; then
  BUN_CMD=(bun)
else
  require_cmd npx
  BUN_CMD=(npx --yes bun@1.3.13)
fi

if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  echo "ERROR: missing required command: sha256sum or shasum" >&2
  exit 1
fi

private_value="$("$NODE_BIN" -p "require(process.argv[1]).private === true ? 'true' : 'false'" "$CLI_PACKAGE")"
if [ "$private_value" != "true" ]; then
  echo "ERROR: packages/cli/package.json must keep private:true" >&2
  exit 1
fi

version="$("$NODE_BIN" -p "require(process.argv[1]).version" "$CLI_PACKAGE")"
artifact_name="cattyneo-autokit-${version}.tgz"
artifact_path="$RELEASE_DIR/$artifact_name"
checksum_path="$artifact_path.sha256"

cd "$ROOT_DIR"
"${BUN_CMD[@]}" install
"${BUN_CMD[@]}" run build
/bin/bash scripts/check-assets-hygiene.sh

mkdir -p "$RELEASE_DIR"
rm -f "$artifact_path" "$checksum_path" "$CLI_DIR/$artifact_name"

(
  cd "$CLI_DIR"
  "${BUN_CMD[@]}" pm pack
)

if [ ! -f "$CLI_DIR/$artifact_name" ]; then
  echo "ERROR: expected pack artifact not found: $CLI_DIR/$artifact_name" >&2
  exit 1
fi

mv "$CLI_DIR/$artifact_name" "$artifact_path"

(
  cd "$RELEASE_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$artifact_name" > "$checksum_path"
  else
    shasum -a 256 "$artifact_name" > "$checksum_path"
  fi
)

printf 'release artifact\t%s\n' "$artifact_path"
printf 'checksum\t%s\n' "$checksum_path"
