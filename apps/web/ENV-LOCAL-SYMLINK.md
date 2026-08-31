# apps/web/.env.local is a SYMLINK to ../../.env (monorepo root).
# Next.js auto-loads .env.local from the app dir; we keep one source of truth
# (root .env) and symlink instead of duplicating secrets.
# If you delete .env.local, recreate it with:
#   ln -sf ../../.env apps/web/.env.local
