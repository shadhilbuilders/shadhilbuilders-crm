# Multi-stage NestJS Dockerfile for Shadhil Builders CRM.
# Phase 1: scaffold only. Real production tuning lands in Week 12.

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

# Copy workspace files first (better layer caching)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./

# Copy all packages and apps
COPY packages/ packages/
COPY apps/backend/ apps/backend/

# Install deps
RUN pnpm install --frozen-lockfile

# Generate Prisma client
RUN pnpm --filter @shadhil/database generate

# Build the backend
RUN pnpm --filter @shadhil/backend build

# ── Production stage ─────────────────────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

# Copy only the built artifacts + runtime deps
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/ packages/
COPY --from=builder /app/apps/backend/dist apps/backend/dist
COPY --from=builder /app/apps/backend/package.json apps/backend/

# eng review A5: NestJS boot-time check reads this. If not 'session',
# bootstrap throws PoolModeError.
ENV POOL_MODE=session
ENV NODE_ENV=production
ENV API_PORT=8080

EXPOSE 8080

# Non-root user (security hardening — Week 12)
USER node

CMD ["node", "apps/backend/dist/main.js"]
