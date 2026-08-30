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

// The Prisma generator `output` in schema.prisma points to a custom directory
// (../node_modules/.prisma/client), so the generated client is NOT re-exported
// from the default `@prisma/client` package. Import directly from the
// generator output path.
import { PrismaClient } from '../node_modules/.prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Explicit type so the cross-package inference doesn't reach into the
// generated client's internal paths (TS2742 portability error).
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
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
export type { PrismaClient } from '../node_modules/.prisma/client';
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
} from '../node_modules/.prisma/client';
