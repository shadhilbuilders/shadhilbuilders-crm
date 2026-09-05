#!/usr/bin/env bash
# scripts/lighthouse-pwa.sh - Run Lighthouse PWA audit on a deployed URL.
#
# Usage: ./scripts/lighthouse-pwa.sh <url>
# Example: ./scripts/lighthouse-pwa.sh https://shadhil-crm-git-pwa-mvp-shadhilbuilders.vercel.app
#
# Requires: node + npx (ships with npm). Lighthouse is fetched on demand via
# `npx --yes lighthouse@11.7.1` - DO NOT bump to 12.x or newer: Google removed
# the `pwa` category in Lighthouse 12 (see web.dev changelog Oct 2025).
# 11.7.1 is the last release with a scored PWA category, so we pin exactly.
# First run downloads + caches the tarball (~10s); subsequent runs are fast.
#
# Requires: chrome (or chromium). On WSL: `which chromium-browser` or
# `which google-chrome`. If multiple are installed, the script prefers
# google-chrome → chromium → chrome.
#
# What this checks (PWA category, target ≥ 90):
#   - Installable manifest (icons, start_url, display, theme color)
#   - Service worker registered
#   - Works offline (fetch responds 200 when SW serves precache)
#   - Splash screen configured
#   - Theme color set
#   - Maskable icon present
#
# Outputs JSON to ./lighthouse-report.json and prints a pass/fail summary
# to stdout. Exit code 0 = pass, 1 = fail.

set -euo pipefail

URL="${1:?Usage: $0 <url>}"

# Chrome / Chromium resolution. Prefer google-chrome; fall back to chromium.
# Export CHROME_PATH so Lighthouse's auto-detection finds it.
if command -v google-chrome >/dev/null 2>&1; then
  CHROME_BIN="$(command -v google-chrome)"
elif command -v chromium >/dev/null 2>&1; then
  CHROME_BIN="$(command -v chromium)"
elif command -v chromium-browser >/dev/null 2>&1; then
  CHROME_BIN="$(command -v chromium-browser)"
elif command -v chrome >/dev/null 2>&1; then
  CHROME_BIN="$(command -v chrome)"
else
  echo "Chrome/Chromium not found. Install one (or set CHROME_PATH)."
  exit 1
fi
export CHROME_PATH="$CHROME_BIN"

# npx itself does the right thing if missing, but fail fast with a clearer
# message instead of "command not found" buried under a npx download.
if ! command -v npx >/dev/null 2>&1; then
  echo "npx not found. Install Node.js (npx ships with npm)."
  exit 1
fi

REPORT_PATH="${REPORT_PATH:-./lighthouse-report.json}"
LH_VERSION="11.7.1"

echo "Running Lighthouse PWA audit on $URL"
echo "Chrome:  $CHROME_BIN"
echo "LH ver:  $LH_VERSION  (pinned: 12+ removed the PWA category)"
echo "Report:  $REPORT_PATH"

# Headless, desktop preset (PWA install checks work on desktop), JSON output.
# `--no-sandbox` + `--disable-dev-shm-usage` are required to run as root or
# inside containers / WSL where /dev/shm is too small for Chromium.
npx --yes "lighthouse@${LH_VERSION}" "$URL" \
  --only-categories=pwa \
  --preset=desktop \
  --output=json \
  --output-path="$REPORT_PATH" \
  --quiet \
  --chrome-flags="--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage"

# Parse PWA score from the JSON.
PWA_SCORE=$(python3 -c "import json; d=json.load(open('$REPORT_PATH')); s=d['categories']['pwa']['score']; print(int(s*100) if s is not None else 'N/A')")

echo
echo "=========================================="
echo "  PWA Score: $PWA_SCORE / 100"
echo "=========================================="

# Print the failed audits (if any) so the user can see what to fix.
python3 -c "
import json, sys
d = json.load(open('$REPORT_PATH'))
for ref in d['categories']['pwa']['auditRefs']:
    audit = d['audits'][ref['id']]
    if audit.get('score') is not None and audit['score'] < 1:
        print(f\"  [{audit['score']:.2f}] {ref['id']}: {audit['title']}\")
        if audit.get('description'):
            print(f\"           {audit['description'][:200]}\")
        # If the audit has item-level failure reasons (e.g. installable-manifest
        # returns a 'Failure reason' row), surface it so the user doesn't have
        # to open the JSON to find out the icon URL returned 404 or HTML.
        details = audit.get('details') or {}
        items = details.get('items') or []
        for it in items:
            reason = it.get('reason') or it.get('description')
            if reason:
                print(f\"           → {reason[:240]}\")
"

# Pass/fail exit code.
if [[ "$PWA_SCORE" =~ ^[0-9]+$ ]] && [ "$PWA_SCORE" -ge 90 ]; then
  echo
  echo "✓ PASS - Task 15 (Lighthouse PWA ≥ 90) satisfied"
  exit 0
else
  echo
  echo "✗ FAIL - Lighthouse PWA score below 90. See $REPORT_PATH for full details."
  exit 1
fi