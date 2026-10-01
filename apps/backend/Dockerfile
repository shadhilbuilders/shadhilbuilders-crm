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

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

# Workspace files first (better layer caching)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./

# Packages + backend only. apps/web is deliberately excluded: its postinstall
# hook needs bash (not in alpine) and this image doesn't ship the web app.
COPY packages/ packages/
COPY apps/backend/ apps/backend/

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
FROM node:22-alpine AS production
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

# Runtime deps: root node_modules (hoisted devtool bins are harmless) +
# per-workspace node_modules with the real dependency symlinks (pnpm
# isolated linker keeps @nestjs/* etc. under apps/backend/node_modules).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/backend apps/backend
COPY --from=builder /app/packages/ packages/

# eng review A5: NestJS boot-time check reads this. If not 'session',
# bootstrap throws PoolModeError.
ENV POOL_MODE=session
ENV NODE_ENV=production
ENV API_PORT=8080

EXPOSE 8080

# Non-root user (security hardening).
USER node

CMD ["node", "apps/backend/dist/main.js"]