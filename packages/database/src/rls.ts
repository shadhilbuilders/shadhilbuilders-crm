// ────────────────────────────────────────────────────────────────────────────
// Shadhil Builders CRM - RLS context helper
// ────────────────────────────────────────────────────────────────────────────
// Sets the per-request session variables that drive PostgreSQL Row-Level
// Security policies. Must be called inside a transaction (uses SET LOCAL)
// so the vars are scoped to that transaction only - no cross-request bleed.
//
// Usage:
//   const result = await withRlsContext(prisma, {
//     userId: 'cuid',
//     role:   'TELECALLER',
//     organizationId: 'cuid',
//   }, async (tx) => {
//     return tx.lead.findMany();
//   });
//
// ENG REVIEW A5: requires POOL_MODE=session in PgBouncer. The bare client
// (this module's `prisma` export) is NOT subject to RLS because the DB
// role used is typically the owner/migration role.
//
// SECOND-ROUND AUDIT (AR-1b, 2026-08-31): the app now connects as the
// non-owner role `shadhil_app` on the pooled DATABASE_URL, and every policy
// table is FORCE ROW LEVEL SECURITY (policies.sql), so this transaction
// context is what actually gates visibility.
// ────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from './generated/prisma/client';

// OWNER is org-owner (DB enum has it) but carries no RLS powers of its
// own - withRlsContext downcasts it to ADMIN. There is EXACTLY ONE owner
// (partial unique index one_owner, migration 20260831110200); they
// bootstrap admins and are outside the business surfaces (no leads, no
// teams) by design.
//
// CRON_SERVICE is a service-account marker, NOT a real user role - it
// lives only in the Postgres `app.user_role` GUC set by withRlsContext
// so the reminder cron's claim UPDATE can satisfy the
// reminder_cron_service RLS policy. It has no Prisma enum value, no
// JWT claim (auth-client/Role excludes it), and no business-surface
// permissions. The cron uses `userId: 'cron-service'` to satisfy the
// NOT-NULL gate on audit inserts. See
// packages/database/prisma/migrations/20260907090000_reminder_cron_service_policy/
// for the policy and known-runtime-bugs.md Bug 8 for context.
//
// PUBLIC_API is the anonymous public-endpoint marker (feedback submit).
// Like CRON_SERVICE it is a GUC-only marker, not a Prisma enum / JWT
// claim. It has INSERT-only RLS power on the Feedback table
// (feedback_insert_public_api) and CANNOT read/mutate anything else.
// The public endpoint sets it via withRlsContext.
export type Role =
  | 'OWNER'
  | 'ADMIN'
  | 'MANAGER'
  | 'SALES_EXEC'
  | 'TELECALLER'
  | 'CRON_SERVICE'
  | 'PUBLIC_API';

export interface RlsContext {
  userId: string;
  role: Role;
  /** T-ORG: the tenant the actor belongs to. Drives app.user_org_id so
   *  every org-scoped policy gates on it. */
  organizationId: string;
}

export type RlsTx = Parameters<
  Parameters<PrismaClient['$transaction']>[0]
>[0];

/**
 * T-ORG (eng review Finding 4): single source of truth for deriving an
 * RlsContext from a JWT payload / actor. Every withRlsContext call site
 * should use this so adding an org dimension is one edit here, not ~50
 * scattered literal edits (DRY / AGENTS.md single-source-of-truth).
 *
 * Parameter is structural (not the auth-client JwtPayload type) so the
 * database package doesn't need to import from auth-client (which would
 * create a package cycle: auth-client imports @shadhil/database for prisma).
 */
export interface RlsActorLike {
  sub: string;
  role: Role;
  organizationId?: string | null;
}

export function rlsContextFrom(actor: RlsActorLike): RlsContext {
  return {
    userId: actor.sub,
    role: actor.role,
    organizationId: actor.organizationId ?? '',
  };
}

const ROLES: readonly string[] = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'SALES_EXEC',
  'TELECALLER',
  'CRON_SERVICE',
  'PUBLIC_API',
];

/**
 * Inline a string as a Postgres SQL literal.
 *
 * SET / SET LOCAL do NOT accept protocol bind parameters ($1) - that was the
 * latent breakage found live during AR verification (Prisma error 42601
 * "syntax error at or near $1", the very first withRlsContext call ever run
 * against a real database). Values are therefore inlined, using dollar-
 * quoting with a random nonce fence so user-influenced ids (cuids) can never
 * break out. Role additionally passed a closed-enum check below.
 */
function sqlLiteral(value: string): string {
  const nonce = Math.random().toString(36).slice(2, 8);
  const fence = `$shadhil_rls_${nonce}$`;
  return `${fence}${value}${fence}`;
}

/**
 * Run `fn` inside a transaction with PostgreSQL RLS session vars set.
 *
 * Guarantees:
 *   - Vars are scoped to THIS transaction (SET LOCAL) - no cross-request bleed.
 *   - role must be a valid Prisma Role enum value; anything else throws
 *     (fail-closed, AR-2 companion).
 *
 * T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): no longer sets
 * app.user_team_id. No RLS policy reads that GUC anymore - every
 * team-scoped policy resolves membership via `TeamMember` (ordinary staff)
 * or `Team.managerId` (managers), both queried directly against
 * app.user_id, which supports multi-team membership (a single-valued GUC
 * never could).
 */
export async function withRlsContext<T>(
  prisma: PrismaClient,
  ctx: RlsContext,
  fn: (tx: RlsTx) => Promise<T>,
): Promise<T> {
  // OWNER has no policies of its own - it travels as ADMIN at the RLS
  // layer (superset semantics: policies already treat 'ADMIN' as
  // unrestricted). Business surfaces key off the JWT's real role, so the
  // distinction is preserved above Postgres.
  //
  // CRON_SERVICE is a service-account marker - it must travel AS-IS so
  // the reminder_cron_service policy can match its GUC. Downcasting
  // would defeat the bypass.
  const rlsRole =
    ctx.role === 'OWNER' ? 'ADMIN' : ctx.role;
  // T-ORG: the org value always travels as-is (never downcast). An actor
  // without an org is a fail-closed state; the policies use
  // current_setting('app.user_org_id', true) which yields NULL here and
  // matches nothing.
  const orgValue = ctx.organizationId;

  if (!ROLES.includes(ctx.role)) {
    throw new Error(`withRlsContext: role "${ctx.role}" is not a valid Role enum value`);
  }
  if (typeof ctx.organizationId !== 'string' || ctx.organizationId.length === 0) {
    throw new Error(`withRlsContext: organizationId is required (got "${ctx.organizationId}")`);
  }

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.user_id = ${sqlLiteral(ctx.userId)}`);
      await tx.$executeRawUnsafe(`SET LOCAL app.user_role = ${sqlLiteral(rlsRole)}`);
      await tx.$executeRawUnsafe(`SET LOCAL app.user_org_id = ${sqlLiteral(orgValue)}`);

      return fn(tx as unknown as RlsTx);
    },
    // Session pooling (pgbouncer, POOL_MODE=session) can make a pooled
    // connection checkout stall well past Prisma's tight defaults
    // (maxWait 2s / timeout 5s) when the server pool is busy under cron
    // load. The result was a noisy "expired transaction ... 5000 ms, however
    // ~19s passed" prisma:error + ERROR[Scheduler] pair from the outbound /
    // reminders crons — a pool stall, not slow SQL (the query itself is
    // sub-ms on an empty/idle table). Raise both so a legitimate checkout
    // wait doesn't kill the transaction; the query bound (100s floor) is far
    // beyond any realistic stall. This is the single gate every business
    // query flows through, so one bump covers all call sites.
    { maxWait: 10_000, timeout: 30_000 },
  );
}