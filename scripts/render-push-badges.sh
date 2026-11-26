#!/usr/bin/env bash
# Renders the push notification badge in shared/push from their SVG sources.
# Needs rsvg-convert (librsvg). Commit the PNG: the plugins copy them at build time.
set -euo pipefail
cd "$(dirname "$0")/../shared/push"
rsvg-convert --width 96 --height 96 --output badge-stack.png badge-stack.svg
