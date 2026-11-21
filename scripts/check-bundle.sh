#!/usr/bin/env bash
# Fails when a built plugin bundle or a defaults file holds a deny-listed identifier.
# It runs the private deny-list check of check-identifiers.sh over every file under the
# given directories, including the file names. The deny-list comes from
# $IDENTIFIERS_DENYLIST (the content, as the CI secret) or from the untracked
# ./.identifiers-denylist file. The check fails when no deny-list is found.
# Output is file:line only: neither the pattern nor the match is printed.
#
# Usage: check-bundle.sh DIR...
set -uo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$root" || exit 2
[ "$#" -gt 0 ] || { echo "usage: check-bundle.sh DIR..." >&2; exit 2; }

files=()
for dir in "$@"; do
  [ -d "$dir" ] || { echo "check-bundle: no such directory: $dir" >&2; exit 2; }
  while IFS= read -r f; do files+=("$f"); done < <(find "$dir" -type f | sort)
done
[ "${#files[@]}" -gt 0 ] || { echo "check-bundle: no files to scan" >&2; exit 2; }

list=""
if [ -n "${IDENTIFIERS_DENYLIST:-}" ] && [ ! -f "${IDENTIFIERS_DENYLIST}" ]; then
  list=$(mktemp)
  trap 'rm -f "$list"' EXIT
  printf '%s\n' "$IDENTIFIERS_DENYLIST" >"$list"
elif [ -n "${IDENTIFIERS_DENYLIST:-}" ]; then
  list="$IDENTIFIERS_DENYLIST"
fi

IDENTIFIERS_DENYLIST="$list" scripts/check-identifiers.sh --denylist-only --require-denylist "${files[@]}"
