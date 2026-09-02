#!/usr/bin/env bash
# scripts/lighthouse-pwa.sh — Run Lighthouse PWA audit on a deployed URL.
#
# Usage: ./scripts/lighthouse-pwa.sh <url>
# Example: ./scripts/lighthouse-pwa.sh https://shadhil-crm-git-pwa-mvp-shadhilbuilders.vercel.app
#
# Requires: lighthouse (npm i -g lighthouse) and chrome (or chromium).
#
# What this checks (PWA category, target ≥ 90):
#   - Installable manifest
#   - Service worker registered
#   - Works offline (fetch responds 200 when SW serves precache)
#   - Splash screen configured
#   - Theme color set
#
# Outputs JSON to ./lighthouse-report.json and prints a pass/fail summary
# to stdout. Exit code 0 = pass, 1 = fail.

set -euo pipefail

URL="${1:?Usage: $0 <url>}"

if ! command -v lighthouse >/dev/null 2>&1; then
  echo "lighthouse CLI not found. Install with: npm i -g lighthouse"
  exit 1
fi

if ! command -v google-chrome chromium chrome >/dev/null 2>&1; then
  echo "Chrome/Chromium not found. Install or set CHROME_PATH."
  exit 1
fi

# Prefer google-chrome, fall back to chromium.
CHROME_BIN="$(command -v google-chrome || command -v chromium || command -v chrome)"
export CHROME_PATH="$CHROME_BIN"

REPORT_PATH="${REPORT_PATH:-./lighthouse-report.json}"

echo "Running Lighthouse PWA audit on $URL"
echo "Chrome: $CHROME_BIN"
echo "Report: $REPORT_PATH"

# Headless, desktop preset (PWA install checks work on desktop), JSON output.
lighthouse "$URL" \
  --only-categories=pwa \
  --preset=desktop \
  --output=json \
  --output-path="$REPORT_PATH" \
  --quiet \
  --chrome-flags="--headless=new --no-sandbox --disable-gpu"

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
"

# Pass/fail exit code.
if [[ "$PWA_SCORE" =~ ^[0-9]+$ ]] && [ "$PWA_SCORE" -ge 90 ]; then
  echo
  echo "✓ PASS — Task 15 (Lighthouse PWA ≥ 90) satisfied"
  exit 0
else
  echo
  echo "✗ FAIL — Lighthouse PWA score below 90. See $REPORT_PATH for full details."
  exit 1
fi
