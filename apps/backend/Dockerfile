# Multi-stage NestJS Dockerfile for Shadhil Builders CRM.
#
# Standard NestJS workflow: `nest build` emits CommonJS dist/, and the
# production stage runs `node dist/main.js` with no runtime transpiler.
# CommonJS require() resolves bare relative imports natively, so workspace
# sources keep extensionless imports and Prisma 7's generated code (which
# uses bare relative imports) works as-is.
#
# Build order matters: workspace packages must emit dist/ BEFORE the backend
# builds/imports them (their package.json exports point at dist/).
#
# tsx is a runtime dependency of @shadhil/backend for local seed/dev scripts;
# it is NOT used to run the production server.
#
# SLIM PROD TREE (2026-10-05). The old runner copied the WHOLE hoisted
# node_modules (1.5 GB) - every workspace's deps and dev tooling included
# (`next` ~200 MB, `@next/swc` ~92 MB, `@turbo` binaries, two TypeScripts).
# That is ~0.7 GB of dead weight in a service that only runs NestJS, and it
# is why a deploy's image transfer took ~20 min/image and blew the 45-min CI
# job cap. The runner now installs a PRODUCTION-ONLY tree scoped to
# @shadhil/backend's dependency closure. `prisma` and `tsx` are declared as
# real dependencies of @shadhil/database (not devDependencies) precisely
# because this image runs them: the deploy workflow executes
# `prisma migrate deploy` and seeds via `tsx` inside the container.
#
# The /app/apps/backend and /app/packages/... layout is preserved so the
# deploy workflow's in-container paths keep working unchanged.

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:26-alpine AS builder
WORKDIR /app

# node:26-alpine doesn't include corepack - install pnpm directly
RUN npm install -g pnpm@12.8.1

# Workspace files first (better layer caching)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./

# Packages + backend + other apps (needed for frozen-lockfile to find all importers)
COPY packages/ packages/
COPY apps/backend/ apps/backend/
COPY apps/web/ apps/web/
COPY apps/realtime-sse/ apps/realtime-sse/

# --ignore-scripts skips app postinstall hooks (bash dependency etc.)
RUN pnpm install --frozen-lockfile --ignore-scripts

# Prisma client is gitignored (.gitignore: packages/database/src/generated/), so
# it does NOT exist in a fresh clone or in this Docker build context. Generate it
# BEFORE anything compiles @shadhil/database: the package's own `build` script
# runs `tsc` first and dies with TS2307 on './generated/prisma/client' otherwise.
# Verified 2026-10-01 (eng review F1): without this line the build fails with
# exit 2 and five TS2307 errors; with it, tsc exits 0.
# `prisma generate` needs no DATABASE_URL (only migrate does) - confirmed by
# running it under an empty env.
RUN pnpm --filter @shadhil/database generate

# Build workspace deps in dependency order, then the backend.
# Each emits dist/ (CommonJS); their package.json exports point at dist/.
RUN pnpm --filter @shadhil/database build
RUN pnpm --filter @shadhil/api-types build
RUN pnpm --filter @shadhil/auth build
RUN pnpm --filter @shadhil/backend build

# ── Production stage ─────────────────────────────────────────────────────────
FROM node:26-alpine AS production
WORKDIR /app

# node:26-alpine doesn't include corepack - install pnpm directly
RUN npm install -g pnpm@12.8.1

# Workspace manifests, needed for the scoped prod install below.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./

# App + package MANIFESTS + built output from the builder. Copying the whole
# apps/packages trees also brings each package's own node_modules where the
# builder already linked its workspace deps.
COPY --from=builder /app/apps/backend apps/backend
COPY --from=builder /app/packages/ packages/

# Replace the builder's full (dev-inclusive) tree with a prod-only install
# scoped to the backend closure. This drops web-only and dev-only packages
# (~0.7 GB). --ignore-scripts because app postinstalls need bash (alpine has
# none) and nothing they do is wanted in an image.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
      --filter "@shadhil/backend..."

# ...but @prisma/engines' postinstall IS wanted. The deploy workflow runs
# `prisma migrate deploy` INSIDE this container as the non-root `node` user,
# and the CLI needs the schema-engine binary that postinstall downloads. With
# --ignore-scripts it was never fetched, so the CLI tried to download it at
# RUNTIME into the root-owned .pnpm dir and died with
#   Can't write to /app/node_modules/.pnpm/@prisma+engines@*/.../@prisma/engines
#   please make sure you install "prisma" with the right permissions
# (EACCES - the 2026-10-06 deploy failure; the old pre-slim image carried the
# binary because it copied the builder's full tree, whose install had already
# run the postinstall). Re-run just that package's postinstall here, at build
# time, as root: the binary lands 0755, so the runtime `node` user can exec it.
RUN pnpm rebuild @prisma/engines

# eng review A5: NestJS boot-time check reads this. If not 'session',
# bootstrap throws PoolModeError.
ENV POOL_MODE=session
ENV NODE_ENV=production
ENV API_PORT=8080

EXPOSE 8080

# Non-root user (security hardening).
USER node

CMD ["node", "apps/backend/dist/main.js"]
