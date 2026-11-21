#!/usr/bin/env bash
# Fails when a built plugin bundle or a defaults file holds a deny-listed identifier.
# It runs the private deny-list check of check-identifiers.sh over every file under the
# given directories, including the file names. The deny-list comes from
# $IDENTIFIERS_DENYLIST (the content, as the CI secret) or from the untracked
# ./.identifiers-denylist file, plus $IDENTIFIERS_DENYLIST_EXTRA (comma-separated).
# The check fails when no deny-list entry is found.
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

# The deny-list is the union of two sources. Either one may be empty or missing.
#   IDENTIFIERS_DENYLIST        one regex per line (the content, or a file path)
#   IDENTIFIERS_DENYLIST_EXTRA  entries separated by commas or new lines (the content)
# When neither source gives an entry, the check fails.
list=$(mktemp)
trap 'rm -f "$list"' EXIT
if [ -n "${IDENTIFIERS_DENYLIST:-}" ]; then
  if [ -f "${IDENTIFIERS_DENYLIST}" ]; then cat "$IDENTIFIERS_DENYLIST" >>"$list"; else printf '%s\n' "$IDENTIFIERS_DENYLIST" >>"$list"; fi
elif [ -f "$root/.identifiers-denylist" ]; then
  cat "$root/.identifiers-denylist" >>"$list"
fi
if [ -n "${IDENTIFIERS_DENYLIST_EXTRA:-}" ]; then
  printf '%s\n' "$IDENTIFIERS_DENYLIST_EXTRA" | tr ',' '\n' >>"$list"
fi
# Drop blanks and comments. Print only the count, never a value.
grep -vE '^[[:space:]]*(#|$)' "$list" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' >"$list.clean"
mv "$list.clean" "$list"
count=$(wc -l <"$list")
echo "check-bundle: ${#files[@]} files, $count deny-list entries"
[ "$count" -gt 0 ] || { echo "check-bundle: no deny-list entry found. Failing closed." >&2; exit 1; }

IDENTIFIERS_DENYLIST="$list" scripts/check-identifiers.sh --denylist-only --require-denylist "${files[@]}"
