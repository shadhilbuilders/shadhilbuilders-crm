# Multi-stage Dockerfile for the standalone SSE service (apps/realtime-sse).
#
# Added 2026-10-01 (eng review F3): the service existed and was wired into the
# web BFF and docker-compose.dev-proxy.yml, but had NO Dockerfile - so it could
# not be deployed through Coolify at all, leaving every SSE call 502ing against
# the web container. Plan §5.0/§10 + Decision Audit #33 require this service on
# its own subdomain (sse.crm.shadhilbuilders.in) at :8090.
#
# Runtime shape: the package has no build step (tsconfig sets noEmit) - it runs
# TypeScript directly through tsx. So the production stage keeps the tsx binary
# instead of compiling to dist/. If a `build` script is ever added, switch the
# runner to `node dist/server.js` and drop devDependencies.
#
# Build context is the REPO ROOT (not apps/realtime-sse/): the service imports
# @shadhil/database and @shadhil/api-types through workspace symlinks, and those
# packages must be built from source here.

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

# Workspace files first (better layer caching)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./

# Packages + this app only. apps/web and apps/backend are also needed for
# frozen-lockfile - lockfile records them as importers.
COPY packages/ packages/
COPY apps/realtime-sse/ apps/realtime-sse/
COPY apps/web/ apps/web/
COPY apps/backend/ apps/backend/

# --ignore-scripts skips app postinstall hooks (bash dependency etc.)
RUN pnpm install --frozen-lockfile --ignore-scripts

# Prisma client is gitignored (.gitignore: packages/database/src/generated/), so
# it does NOT exist in a fresh clone / Docker context. It must be generated
# BEFORE anything compiles @shadhil/database - the package's `build` script runs
# `tsc` first and dies with TS2307 on ./generated/prisma/client otherwise.
# (Same defect the API image had; verified 2026-10-01.)
RUN pnpm --filter @shadhil/database generate

# Build workspace deps in dependency order. Each emits CommonJS dist/.
RUN pnpm --filter @shadhil/database build
RUN pnpm --filter @shadhil/api-types build

# ── Production stage ─────────────────────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

# Runtime deps: root node_modules (hoisted) + per-workspace node_modules with the
# real symlinks (pnpm's isolated linker keeps tsx under the app's node_modules).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/ packages/
COPY --from=builder /app/apps/realtime-sse apps/realtime-sse

ENV NODE_ENV=production
ENV REALTIME_SSE_PORT=8090
# CORS is the BROWSER origin only - the SSE service is reached through the web
# BFF, and the ticket in the URL is the auth credential (no cookies by design,
# Decision #33/#37). Override in Coolify.
ENV CORS_ORIGINS=https://crm.shadhilbuilders.in

EXPOSE 8090

# Non-root user (security hardening). Matches the other two images.
USER node

# Run from the package dir so relative source paths resolve, mirroring the
# package.json `start` script. --env-file-if-exists tolerates a missing ../../.env
# (in production every value comes from Coolify env vars).
WORKDIR /app/apps/realtime-sse
CMD ["/app/apps/realtime-sse/node_modules/.bin/tsx", "--env-file-if-exists=../../.env", "src/server.ts"]
