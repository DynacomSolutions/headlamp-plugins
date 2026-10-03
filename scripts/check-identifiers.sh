#!/usr/bin/env bash
# Fails when repository content leaks identifiers. This repo is (or will be)
# public, so it must contain only generic placeholders (example.com etc.).
#
# Generic checks (always run, also in CI):
#   - private/internal IPv4 addresses (RFC1918, CGNAT, link-local)
#   - *.local / *.internal hostnames
#   - email addresses other than @example.com / noreply
# Private check (CI uses a repo secret; locally an untracked file):
#   - every pattern in an UNTRACKED deny-list file, one case-insensitive
#     extended regex per line ('#' comments and blank lines ignored).
#     Location: $IDENTIFIERS_DENYLIST, else ./.identifiers-denylist
#     (gitignored). The deny-list itself must never be committed.
#
# Output policy: matches are reported as file:line only. Neither the pattern
# nor the matched text is ever printed, so CI logs cannot leak identifiers.
#
# Usage: check-identifiers.sh [--all] [--require-denylist] [FILE...]
#   --all               scan every tracked + untracked-unignored file
#   --require-denylist  fail if no deny-list is found (default: warn)
# A line containing the marker "identifiers-allow" is exempt from the generic
# checks (use sparingly, e.g. in documentation of the rules themselves).
set -uo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$root" || exit 2

all=0
require=0
files=()
for arg in "$@"; do
  case "$arg" in
    --all) all=1 ;;
    --require-denylist) require=1 ;;
    *) files+=("$arg") ;;
  esac
done

if [ "$all" = 1 ]; then
  mapfile -t files < <(git ls-files -co --exclude-standard)
fi
if [ "${#files[@]}" -eq 0 ]; then
  exit 0
fi

# Never scan the deny-list itself, lock files' integrity blobs are harmless.
scan=()
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  case "$f" in
    .identifiers-denylist | */.identifiers-denylist) continue ;;
  esac
  scan+=("$f")
done
[ "${#scan[@]}" -gt 0 ] || exit 0

fail=0
report() { # label, grep output (reduced to file:line, never content)
  if [ -n "$2" ]; then
    printf 'identifier-check: %s\n%s\n\n' "$1" "$(printf '%s\n' "$2" | cut -d: -f1,2 | sort -u)" >&2
    fail=1
  fi
}

allow='identifiers-allow'

ip_re='(?<![0-9.])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}|169\.254\.[0-9]{1,3}\.[0-9]{1,3})(?![0-9])'
host_re='(?<![A-Za-z0-9_$.-])[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.(local|internal|lan|home\.arpa)(?![A-Za-z0-9_-])'
mail_re='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'

out=$(grep -HInP --color=never "$ip_re" -- "${scan[@]}" 2>/dev/null | grep -v "$allow")
report "private/internal IP address" "$out"

out=$(grep -HInP --color=never "$host_re" -- "${scan[@]}" 2>/dev/null | grep -v "$allow")
report "internal hostname (*.local / *.internal)" "$out"

# Lock files carry third-party package author emails; skip them for this check.
mail_scan=()
for f in "${scan[@]}"; do
  case "$f" in
    *package-lock.json | *yarn.lock | *pnpm-lock.yaml) ;;
    *) mail_scan+=("$f") ;;
  esac
done
[ "${#mail_scan[@]}" -gt 0 ] || mail_scan=(/dev/null)
out=$(grep -HInoP --color=never "$mail_re" -- "${mail_scan[@]}" 2>/dev/null \
  | grep -v "$allow" \
  | grep -viE '@example\.(com|org|net)$|noreply|no-reply|^[^:]+:[0-9]+:git@github\.com$')
report "email address (only @example.com or noreply allowed)" "$out"

denylist="${IDENTIFIERS_DENYLIST:-$root/.identifiers-denylist}"
if [ -f "$denylist" ]; then
  patterns=$(mktemp)
  trap 'rm -f "$patterns"' EXIT
  grep -vE '^[[:space:]]*(#|$)' "$denylist" >"$patterns"
  if [ -s "$patterns" ]; then
        out=$(grep -HInif "$patterns" --color=never -- "${scan[@]}" 2>/dev/null | grep -v '"integrity"' | cut -d: -f1,2)
    report "deny-listed identifier" "$out"
  fi
else
  msg="identifier-check: no deny-list at $denylist (private check skipped)"
  if [ "$require" = 1 ]; then
    echo "$msg" >&2
    fail=1
  else
    echo "$msg" >&2
  fi
fi

if [ "$fail" != 0 ]; then
  echo "identifier-check: FAILED. Use generic placeholders (example.com, 192.0.2.x is NOT private and is fine)." >&2
  exit 1
fi
exit 0
