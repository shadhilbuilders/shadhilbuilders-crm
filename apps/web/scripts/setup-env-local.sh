#!/usr/bin/env bash
# apps/web/scripts/setup-env-local.sh
#
# Ensures `apps/web/.env.local` exists as a symlink to the monorepo root
# `.env` so Next.js auto-loads it. Next 16 only auto-loads env files from
# the app's own directory; we keep one source of truth at the root and
# symlink in.
#
# Idempotent: no-op if the symlink is already correct.
# Safe to run on every `pnpm install` (postinstall hook).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$APP_DIR/.env.local"
SOURCE="../../.env"

# Resolve to absolute path for the comparison (handles relative symlinks).
SOURCE_ABS="$(cd "$APP_DIR" && cd "$(dirname "$SOURCE")" && pwd)/$(basename "$SOURCE")"

if [ -L "$TARGET" ]; then
  CURRENT="$(readlink "$TARGET")"
  CURRENT_ABS="$(cd "$APP_DIR" && cd "$(dirname "$CURRENT")" 2>/dev/null && pwd)/$(basename "$CURRENT")" 2>/dev/null || true
  if [ "$CURRENT" = "$SOURCE" ] || [ "$CURRENT_ABS" = "$SOURCE_ABS" ]; then
    # Already correct.
    exit 0
  fi
  # Wrong target — replace it.
  rm "$TARGET"
elif [ -e "$TARGET" ]; then
  # Real file exists at this path. Don't clobber user-created config.
  echo "setup-env-local: $TARGET exists and is not a symlink. Skipping." >&2
  exit 0
fi

# Ensure the source exists before linking.
if [ ! -e "$APP_DIR/$SOURCE" ]; then
  echo "setup-env-local: $APP_DIR/$SOURCE does not exist. Run from a checkout that includes the root .env." >&2
  exit 0
fi

ln -s "$SOURCE" "$TARGET"
echo "setup-env-local: linked $TARGET -> $SOURCE"
