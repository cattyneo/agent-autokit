#!/usr/bin/env bash
set -euo pipefail

AUTOKIT_REPO="${AUTOKIT_REPO:-cattyneo/agent-autokit}"
AUTOKIT_VERSION="${AUTOKIT_VERSION:-}"
GH_BIN="${GH_BIN:-gh}"
NPM_BIN="${NPM_BIN:-npm}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: missing required command: $1" >&2
    exit 1
  fi
}

cleanup() {
  if [ -n "${tmp_dir:-}" ] && [ -d "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
}

require_cmd "$GH_BIN"
require_cmd "$NPM_BIN"
require_cmd mktemp

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/autokit-install.XXXXXX")"
trap cleanup EXIT

tag_arg=()
if [ -n "$AUTOKIT_VERSION" ]; then
  version_without_v="${AUTOKIT_VERSION#v}"
  tag_arg=("v$version_without_v")
  pattern="cattyneo-autokit-${version_without_v}.tgz"
else
  pattern="cattyneo-autokit-*.tgz"
fi

"$GH_BIN" release download "${tag_arg[@]}" \
  --repo "$AUTOKIT_REPO" \
  --pattern "$pattern" \
  --dir "$tmp_dir" \
  --clobber

tarball_count="$(find "$tmp_dir" -maxdepth 1 -type f -name 'cattyneo-autokit-*.tgz' | wc -l | tr -d ' ')"
if [ "$tarball_count" != "1" ]; then
  echo "ERROR: expected exactly one autokit tarball, found $tarball_count" >&2
  find "$tmp_dir" -maxdepth 1 -type f -print >&2
  exit 1
fi

tarball="$(find "$tmp_dir" -maxdepth 1 -type f -name 'cattyneo-autokit-*.tgz' -print | sed -n '1p')"
checksum_name="$(basename "$tarball").sha256"
if "$GH_BIN" release download "${tag_arg[@]}" \
  --repo "$AUTOKIT_REPO" \
  --pattern "$checksum_name" \
  --dir "$tmp_dir" \
  --clobber >/dev/null 2>&1; then
  (
    cd "$tmp_dir"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum -c "$checksum_name"
    elif command -v shasum >/dev/null 2>&1; then
      shasum -a 256 -c "$checksum_name"
    else
      echo "WARN: checksum asset downloaded but sha256sum/shasum is unavailable" >&2
    fi
  )
fi

"$NPM_BIN" i -g "$tarball"
global_prefix="$("$NPM_BIN" prefix -g)"
autokit_bin="$global_prefix/bin/autokit"
if [ -x "$autokit_bin" ]; then
  "$autokit_bin" --version
else
  autokit --version
fi
