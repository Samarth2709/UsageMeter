#!/usr/bin/env bash
set -euo pipefail

target=${1:?Usage: clear-macos-xattrs.sh <app-bundle>}

xattr -cr "$target" 2>/dev/null || true
find "$target" -xattr -exec xattr -c {} + 2>/dev/null || true
find "$target" -xattr -exec sh -c '
  for file do
    for attribute in $(xattr "$file" 2>/dev/null); do
      xattr -d "$attribute" "$file" 2>/dev/null || true
    done
  done
' sh {} + || true
