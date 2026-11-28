// ────────────────────────────────────────────────────────────────────────────
// Tenant identity: is it unforgeable? (2026-11-28)
// ────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS: every RLS policy in this schema keys off session GUCs -
// `app.user_org_id`, `app.user_role`, `app.user_id` - and zero policies reference
// `current_user`. Postgres therefore cannot tell the application apart from anyone
// else holding the same credential: whoever connects sets the GUCs.
//
// Measured on dev as `shadhil_app` (the non-superuser, RLS-enforced role the API
// uses): no GUCs, 0 leads; GUCs forged for the other three organisations, 31, 158
// and 66 leads respectively. RLS stops a bad JOIN, not a leaked `DATABASE_URL`.
//
// This test is a CHARACTERISATION of that gap, not an endorsement of it. It is
// green today and it must go red the day tenancy becomes unforgeable - a per-tenant
// login, a signed tenant token verified inside a SECURITY DEFINER function, or a
// database per tenant. When that lands, flip the expectation to 0 in this file;
// that flip is the evidence the fix worked.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/index';
import { createDirectPrismaClient } from '../src/test-db-isolation';

const HAS_DB = Boolean(process.env.DATABASE_URL);

const TAG = `tf${Date.now().toString(36)}`;
const ORG_VICTIM = `${TAG}victim`.padEnd(24, '0');
const ORG_CALLER = `${TAG}caller`.padEnd(24, '0');

const direct = createDirectPrismaClient();

beforeAll(async () => {
  if (!HAS_DB) return;
  await direct.organization.createMany({
    data: [
      { id: ORG_VICTIM, name: `${TAG} victim`, slug: `${TAG}-victim` },
      { id: ORG_CALLER, name: `${TAG} caller`, slug: `${TAG}-caller` },
    ],
  });
});

afterAll(async () => {
  if (HAS_DB) {
    await direct.organization.deleteMany({
      where: { id: { in: [ORG_VICTIM, ORG_CALLER] } },
    });
  }
  await direct.$disconnect();
});

describe.skipIf(!HAS_DB)('tenant identity', () => {
  it('hides another tenant when the session carries no tenant', async () => {
    const seen = await prisma.organization.count({ where: { id: ORG_VICTIM } });

    expect(seen).toBe(0);
  });

  it('is forgeable by any credential that can run SQL (known gap)', async () => {
    // Two SET calls are the whole attack. No escalation, no superuser, nothing the
    // API role cannot already do.
    const seen = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`select set_config('app.user_org_id', $1, true)`, ORG_VICTIM);
      await tx.$executeRawUnsafe(`select set_config('app.user_role', 'ADMIN', true)`);

      return tx.organization.count({ where: { id: ORG_VICTIM } });
    });

    // 1 today, because the policy trusts the GUC. Change to 0 when the tenant
    // identity stops being something the caller can choose.
    expect(seen).toBe(1);
  });
});
