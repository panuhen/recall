#!/usr/bin/env bash
# Regenerate the OpenGraph / Twitter card image (public/og-card.png) from
# scripts/og-card.html. Requires google-chrome (or chromium) in PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME=${CHROME:-google-chrome}
"$CHROME" \
  --headless \
  --disable-gpu \
  --hide-scrollbars \
  --force-device-scale-factor=1 \
  --window-size=1200,630 \
  --virtual-time-budget=3000 \
  --screenshot="public/og-card.png" \
  "file://$PWD/scripts/og-card.html"

echo "Regenerated: public/og-card.png"
