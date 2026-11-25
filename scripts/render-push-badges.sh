#!/usr/bin/env bash
# Renders the push notification badges in shared/push from their SVG sources.
# Needs rsvg-convert (librsvg). Commit the PNGs: the plugins copy them at build time.
set -euo pipefail
cd "$(dirname "$0")/../shared/push"
for name in badge badge-stack; do
  rsvg-convert --width 96 --height 96 --output "$name.png" "$name.svg"
done
