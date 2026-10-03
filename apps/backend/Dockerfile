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

# Runtime deps: root node_modules (hoisted devtool bins are harmless) +
# per-workspace node_modules with the real dependency symlinks (pnpm
# isolated linker keeps @nestjs/* etc. under apps/backend/node_modules).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/backend apps/backend
COPY --from=builder /app/packages/ packages/

# Fix better-auth hex.decode bug: it returns UTF-8 string instead of Uint8Array
# This breaks password verification for non-UTF8 salts (all random salts)
RUN sed -i 's/return new TextDecoder().decode(result);/return result;/' /app/node_modules/.pnpm/@better-auth+utils@0.4.2/node_modules/@better-auth/utils/dist/hex.mjs

# Fix better-auth password.generateKey bug: it passes salt hex string directly to scryptAsync
# instead of decoding it with hex.decode() first
RUN sed -i 's/scryptAsync(password.normalize("NFKC"), salt, {/scryptAsync(password.normalize("NFKC"), hex.decode(salt), {/' /app/node_modules/.pnpm/@better-auth+utils@0.4.2/node_modules/@better-auth/utils/dist/password.mjs

# Fix better-auth password.node.mjs bug: it passes salt hex string directly to scrypt
# instead of decoding it first
RUN sed -i 's/scrypt(\n      password.normalize("NFKC"),\n      salt,/scrypt(\n      password.normalize("NFKC"),\n      Buffer.from(salt, "hex"),/' /app/node_modules/.pnpm/@better-auth+utils@0.4.2/node_modules/@better-auth/utils/dist/password.node.mjs
RUN sed -i 's/scrypt(\n      password.normalize("NFKC"),\n      salt,/scrypt(\n      password.normalize("NFKC"),\n      Buffer.from(salt, "hex"),/' /app/node_modules/.pnpm/better-auth@1.7.2_@cloudflare+workers-types@5.20260830.1_@prisma+client@7.10.0_prisma@7_92c1e9dc7399a590c431256dd8d09f56/node_modules/@better-auth/utils/dist/password.node.mjs

# Fix better-auth create-context.mjs: it imports verifyPassword from crypto/password.mjs
# which is a wrapper expecting { hash, password } object, but the code calls it with (hash, password) as two args
# Need to import the raw verifyPassword from @better-auth/utils/password instead
RUN sed -i 's/import { hashPassword, verifyPassword } from "..\/crypto\/password.mjs";/import { hashPassword, verifyPassword } from "@better-auth\/utils\/password";/' /app/node_modules/.pnpm/better-auth@1.7.2_@cloudflare+workers-types@5.20260830.1_@prisma+client@7.10.0_prisma@7_92c1e9dc7399a590c431256dd8d09f56/node_modules/better-auth/dist/context/create-context.mjs

# eng review A5: NestJS boot-time check reads this. If not 'session',
# bootstrap throws PoolModeError.
ENV POOL_MODE=session
ENV NODE_ENV=production
ENV API_PORT=8080

EXPOSE 8080

# Non-root user (security hardening).
USER node

CMD ["node", "apps/backend/dist/main.js"]