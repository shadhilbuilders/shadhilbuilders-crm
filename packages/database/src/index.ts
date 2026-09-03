// ────────────────────────────────────────────────────────────────────────────
// Shadhil Builders CRM — Database client export
// ────────────────────────────────────────────────────────────────────────────
// Single shared PrismaClient instance. Use withRlsContext() (./rls) for any
// query path that should be subject to Row-Level Security — the bare client
// runs as the database role used in DATABASE_URL, which is NOT subject to RLS
// because that role is typically the migration/owner role.
//
// DO NOT instantiate PrismaClient inline elsewhere — import { prisma } from here.
// ────────────────────────────────────────────────────────────────────────────

// The Prisma generator in schema.prisma uses the new `prisma-client` provider
// (Prisma 7 default), with output to `../src/generated/prisma`. The generator
// emits plain TypeScript files (e.g. `client.ts`) that we import like any
// other source — no more directory imports, no `ERR_UNSUPPORTED_DIR_IMPORT`.
// The `moduleFormat: "esm"` field is honored by this provider (silently
// ignored by the old `prisma-client-js`).
import { PrismaClient } from './generated/prisma/client';
// Prisma 7: the client no longer reads a datasource url from schema.prisma —
// it connects through a driver adapter. @prisma/adapter-pg + pg Pool keyed on
// DATABASE_URL (the PgBouncer pooled path; POOL_MODE must be 'session' for
// RLS SET LOCAL to work — boot-check verifies).
// NOTE: construction must stay connection-free (smoke tests import this
// chain without a database). pg connects lazily on first query; a missing
// DATABASE_URL therefore surfaces at query time, not import time.
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

if (!process.env.DATABASE_URL && process.env.NODE_ENV !== 'test') {
  // Loud, but not fatal — failing here would break DB-less imports (seed
  // tooling, auth smoke tests). The first query fails with a clear pg
  // error either way; verifyPoolMode() gates the API at boot.
  console.warn(
    '[shadhil/database] DATABASE_URL is not set — Prisma will fail on first query',
  );
}

// Explicit type so the cross-package inference doesn't reach into the
// generated client's internal paths (TS2742 portability error).
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// ── Re-exports ────────────────────────────────────────────────────────────────
// Convenience re-exports so consumers don't need to know the custom output
// path. All Prisma types live next to PrismaClient in the generated client.

// Re-export boot-time utilities (eng review A5: POOL_MODE check)
export { verifyPoolMode, PoolModeError } from './boot-check';
export { withRlsContext } from './rls';
export type { RlsContext, RlsTx } from './rls';
export type { PrismaClient } from './generated/prisma/client';
export type {
  User,
  Team,
  ManagerAssignmentRule,
  Project,
  Phase,
  Unit,
  Lead,
  LeadState,
  LeadOwnerType,
  Activity,
  ActivityType,
  SiteVisit,
  VisitStatus,
  Message,
  MessageDirection,
  MessageChannel,
  Booking,
  BookingStatus,
  UnitStatus,
  Reminder,
  ReminderType,
  ReminderStatus,
  Notification,
  PushSubscription,
  PushPlatform,
  PushNotification,
  PushStatus,
  AuditLog,
  Consent,
  ConsentType,
  WebhookEvent,
  WebhookSource,
  Session,
  Account,
  Verification,
  Role,
} from './generated/prisma/client';
