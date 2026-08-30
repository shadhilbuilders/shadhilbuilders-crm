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

/**
 * Run `fn` inside a transaction with PostgreSQL RLS session vars set.
 *
 * Implementation notes:
 *   - Wraps in prisma.$transaction([...]) so SET LOCAL statements and the
 *     user's queries share the same backend connection.
 *   - Uses $executeRawUnsafe with parameter binding — values are escaped
 *     by Postgres' parameter machinery, NOT concatenated. The "Unsafe"
 *     refers to the lack of a Prisma-model return type, not to SQL safety.
 *   - For null teamId (ADMIN), sets app.user_team_id to empty string —
 *     policies treat NULL and '' as "no team match" (no rows visible).
 */
export async function withRlsContext<T>(
  prisma: PrismaClient,
  ctx: RlsContext,
  fn: (tx: RlsTx) => Promise<T>,
): Promise<T> {
  const teamValue = ctx.teamId ?? '';

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL app.user_id = $1`,
      ctx.userId,
    );
    await tx.$executeRawUnsafe(
      `SET LOCAL app.user_role = $1`,
      ctx.role,
    );
    await tx.$executeRawUnsafe(
      `SET LOCAL app.user_team_id = $1`,
      teamValue,
    );

    return fn(tx as unknown as RlsTx);
  });
}