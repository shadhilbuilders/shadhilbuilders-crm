# syntax=docker/dockerfile:1
#
# Multi-stage Dockerfile for the Next.js web app (apps/web).
#
# Build context is the REPO ROOT (not apps/web/) - the app imports workspace
# packages through pnpm symlinks and next.config.ts transpiles their SOURCE, so
# packages/ must be present next to apps/web/.
#
# 2026-10-01 (eng review F2/F9): this file had three independent breakages that
# all surfaced the moment anyone actually built it. They are fixed below and the
# whole image build now runs in CI (see .github/workflows/ci.yml → docker-images).
#   1. deps stage copied package.json + pnpm-lock.yaml but NOT pnpm-workspace.yaml,
#      so `pnpm install --frozen-lockfile` died with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH
#      (the `overrides` block lives in pnpm-workspace.yaml). The old `COPY . .`
#      masked it because the whole context was present; a slimmed context needs
#      the file copied explicitly.
#   2. the runner copied /app/.next/standalone and ran `node server.js`, but in a
#      monorepo the standalone tree is rooted at the repo root, so the server is
#      at apps/web/server.js.
#   3. postinstall runs bash (scripts/setup-env-local.sh) and node:22-alpine has
#      no bash - the install MUST pass --ignore-scripts.
#
# Mirrors apps/backend/Dockerfile's proven workspace layout deliberately.

# ── Base ──────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
# Pinned to the repo's packageManager field so the image resolves the same
# lockfile semantics as CI and local dev.
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

# ── Builder ───────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

# NEXT_PUBLIC_* vars are baked into the client bundle at build time.
# Pass them as build args so the image is environment-agnostic at runtime.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_APP_NAME=Shadhil Builders
ARG NEXT_PUBLIC_API_BASE_URL
# Browser better-auth client base (packages/auth-client/src/auth-client.ts
# reads this first, then BETTER_AUTH_URL, then falls back to localhost:3000
# - unset it and prod browsers fetch localhost and CORS-die).
ARG NEXT_PUBLIC_BETTER_AUTH_URL
# Server-side, but read at BUILD time: next.config.ts rewrites interpolate
# process.env.BACKEND_API_URL into the route table, so an absent value bakes the
# `http://localhost:8080` fallback into the image and every BFF call then targets
# the web container itself. Declared as a build ARG deliberately (eng review F8,
# 2026-10-01) - pass it from Coolify's Build Arguments alongside the NEXT_PUBLIC_*.
ARG BACKEND_API_URL=http://localhost:8080
ARG NEXT_PUBLIC_DEBUG_MODE=false
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST
# Build ID for cache-busting the service worker. Set at build time via --build-arg.
ARG BUILD_ID=local

# ── Build-time SERVER env (placeholders, NOT secrets) ────────────────────────
# `next build` prerenders routes and imports the auth chain, so two validators run
# DURING THE BUILD: `@t3-oss/env-nextjs` in src/lib/env/env.ts and
# `assertAuthEnv()` in packages/auth-client/src/env.ts (module scope, and it has no
# skip switch). Without values the build dies with
#   Error: Failed to collect page data for /api/docs  (Invalid environment variables)
# (eng review, 2026-10-01).
#
# These are INLINE on the build RUN below, not ENV/ARG, for two reasons: they are
# deliberately fake (they only need to satisfy the min-32-chars / valid-URL shape
# checks), and keeping them off ENV means no scanner mistakes them for baked
# secrets - the values exist only for that one layer. The real values arrive at
# RUNTIME from Coolify. Never pass real secrets as build args.

ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME \
    NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_PUBLIC_BETTER_AUTH_URL=$NEXT_PUBLIC_BETTER_AUTH_URL \
    BACKEND_API_URL=$BACKEND_API_URL \
    NEXT_PUBLIC_DEBUG_MODE=$NEXT_PUBLIC_DEBUG_MODE \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY \
    NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST \
    BUILD_ID=$BUILD_ID \
    NEXT_TELEMETRY_DISABLED=1

# Workspace manifests first (better layer caching). pnpm-workspace.yaml is NOT
# optional: it carries the `overrides` block the lockfile records.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./

# Every workspace package the web app consumes (transpilePackages in
# next.config.ts) plus the app itself. apps/backend is deliberately excluded.
COPY packages/ packages/
COPY apps/web/ apps/web/
# realtime-sse is needed for frozen-lockfile - lockfile records it as importer
COPY apps/realtime-sse/ apps/realtime-sse/

# --ignore-scripts: the web postinstall needs bash, which alpine lacks. Nothing
# it does (symlinking apps/web/.env.local → root .env) is wanted in an image -
# production config arrives as build args and Coolify env vars.
# NOTE the generated Prisma client IS needed here: src/lib/server/tenant.ts and
# the /api/bff route import `prisma` from @shadhil/database. It is produced by the
# `prebuild` hook on the next line, which runs `pnpm --filter @shadhil/database
# generate` before anything compiles. Without that, `next build` fails with
# TS2307 on './generated/prisma/client' exactly like the API image did.
RUN pnpm install --frozen-lockfile --ignore-scripts

# pnpm runs `prebuild` automatically: prisma generate → clean + build the
# workspace packages the app imports → `next build`.
# The inline vars are build-only placeholders (see the note above); they satisfy
# the env validators' shape checks and never reach the runner stage.
RUN BETTER_AUTH_URL=https://crm.shadhilbuilders.in \
    DIRECT_DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder \
    BETTER_AUTH_SECRET=build-time-placeholder-not-a-real-secret-000000 \
    JWT_SECRET=build-time-placeholder-not-a-real-secret-000000 \
    pnpm --filter @shadhil/web build

# ── Runner ────────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# Non-root user for security
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# The standalone tree is rooted at the REPO ROOT in a monorepo, so it lands at
# /app and the server lives at /app/apps/web/server.js (NOT /app/server.js).
# public/ and .next/static are never traced into it and must be copied by hand
# to exactly the paths the server expects.
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000 \
    HOSTNAME=0.0.0.0

CMD ["node", "apps/web/server.js"]
