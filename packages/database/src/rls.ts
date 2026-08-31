// ────────────────────────────────────────────────────────────────────────────
// Shadhil Builders CRM — RLS context helper
// ────────────────────────────────────────────────────────────────────────────
// Sets the per-request session variables that drive PostgreSQL Row-Level
// Security policies. Must be called inside a transaction (uses SET LOCAL)
// so the vars are scoped to that transaction only — no cross-request bleed.
//
// Usage:
//   const result = await withRlsContext(prisma, {
//     userId: 'cuid',
//     role:   'TELECALLER',
//     teamId: 'cuid',
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

import type { PrismaClient } from '../node_modules/.prisma/client';
import type { Role } from '../node_modules/.prisma/client';

export interface RlsContext {
  userId: string;
  role: Role;
  /** null/undefined for ADMIN without an assigned team. */
  teamId: string | null;
}

export type RlsTx = Parameters<
  Parameters<PrismaClient['$transaction']>[0]
>[0];

const ROLES: readonly string[] = ['ADMIN', 'MANAGER', 'SALES_EXEC', 'TELECALLER'];

/**
 * Inline a string as a Postgres SQL literal.
 *
 * SET / SET LOCAL do NOT accept protocol bind parameters ($1) — that was the
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
 *   - Vars are scoped to THIS transaction (SET LOCAL) — no cross-request bleed.
 *   - role must be a valid Prisma Role enum value; anything else throws
 *     (fail-closed, AR-2 companion).
 *   - For null teamId (ADMIN), sets app.user_team_id to empty string —
 *     policies treat NULL and '' as "no team match" (no rows visible).
 */
export async function withRlsContext<T>(
  prisma: PrismaClient,
  ctx: RlsContext,
  fn: (tx: RlsTx) => Promise<T>,
): Promise<T> {
  const teamValue = ctx.teamId ?? '';

  if (!ROLES.includes(ctx.role)) {
    throw new Error(`withRlsContext: role "${ctx.role}" is not a valid Role enum value`);
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.user_id = ${sqlLiteral(ctx.userId)}`);
    await tx.$executeRawUnsafe(`SET LOCAL app.user_role = ${sqlLiteral(ctx.role)}`);
    await tx.$executeRawUnsafe(`SET LOCAL app.user_team_id = ${sqlLiteral(teamValue)}`);

    return fn(tx as unknown as RlsTx);
  });
}