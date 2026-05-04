#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="$ROOT_DIR/docs/SPEC.md"

fail_codes="$(
  awk '/^##### 4\.2\.1\.1/,/^### 4\.3/' "$SPEC" |
    awk 'BEGIN{in_table=0} /^\| code \|/{in_table=1; next} in_table && /^\|---/{next} in_table && /^\|/ { print $2; next } in_table && !/^\|/ { exit }' |
    grep -oE '`[a-z_]+`' | tr -d '`' | sort -u
)"

audit_kinds="$(
  awk '/^##### 10\.2\.2\.2/,/^### 10\.3/' "$SPEC" |
    grep -oE '^- `[^`]+`' |
    sed -E 's/^- `([^`]+)`.*/\1/' |
    sort -u
)"

if ! diff -u <(printf '%s\n' "$fail_codes") <(printf '%s\n' "$audit_kinds"); then
  echo "::error::failure.code <-> audit kind 1:1 mismatch"
  exit 1
fi

echo "traceability checks passed"
