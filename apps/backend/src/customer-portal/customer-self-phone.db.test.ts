// customer_self_phone() (2026-11-26): the buyer's own number, and nobody else's.
//
// protects= the portal can show a buyer the number the office holds without
//           granting CUSTOMER any visibility of the Lead row it lives on;
// fails_when= the function answers without an RLS context, answers for a staff
//           account, answers across an org boundary (a User whose customerLeadId
//           points into another tenant), answers for a soft-deleted account, or
//           answers for an unlinked one;
// no_claim= nothing here exercises the HTTP surface: the mapping from this
//           function to PortalMeDto.phone is pinned in
//           apps/backend/src/customer-portal/customer-portal.service.test.ts.
//
// The function is SECURITY DEFINER, so these cases are the only thing standing
// between a narrow read and a wide one. They are seeded through the owner
// client on purpose: the point is the FUNCTION's own checks, not a policy's.
// It lives in the backend suite because the tenant fixture does: each test gets
// a fresh organisation instead of a slice of the shared demo org.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  prisma as runtimePrisma,
  withRlsContext,
  type PrismaClient,
  type RlsContext,
} from '@shadhil/database';
import { createDirectPrismaClient } from '@shadhil/database/test-db-isolation';

import { createTestTenant, type TestTenant } from '../test-utils/test-tenant';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

let tenant: TestTenant;
let other: TestTenant;

const ids = {
  project: '',
  team: '',
  lead: '',
  foreignLead: '',
  buyer: '',
  staffWithLeadPointer: '',
  unlinkedBuyer: '',
  deletedBuyer: '',
  foreignBuyer: '',
};

const PHONE = '919876500123';
const FOREIGN_PHONE = '919876500456';

const owner = createDirectPrismaClient();

const ctx = (userId: string, role: RlsContext['role'], organizationId: string): RlsContext => ({
  userId,
  role,
  organizationId,
});

/** Call the function inside one RLS context - the only way the backend calls it. */
async function phoneAs(c: RlsContext): Promise<string | null> {
  if (prisma === null) throw new Error('DATABASE_URL is not set: this suite needs a database');
  return withRlsContext(prisma, c, async (tx) => {
    const rows = await tx.$queryRaw<{ phone: string | null }[]>`
      SELECT customer_self_phone() AS phone`;
    return rows[0]?.phone ?? null;
  });
}

beforeAll(async () => {
  tenant = await createTestTenant('self-phone');
  other = await createTestTenant('self-phone-b');
  const org = tenant.organizationId;
  const orgB = other.organizationId;

  const suffix = org.slice(-8);
  ids.project = `csp-${suffix}-proj`;
  ids.team = `csp-${suffix}-team`;
  ids.lead = `csp-${suffix}-lead`;
  ids.foreignLead = `csp-${suffix}-leadb`;
  ids.buyer = `csp-${suffix}-buyer`;
  ids.staffWithLeadPointer = `csp-${suffix}-staff`;
  ids.unlinkedBuyer = `csp-${suffix}-nolink`;
  ids.deletedBuyer = `csp-${suffix}-gone`;
  ids.foreignBuyer = `csp-${suffix}-foreign`;

  await owner.project.create({
    data: {
      id: ids.project,
      name: `Self phone ${suffix}`,
      slug: `csp-${suffix}`,
      address: 'x',
      organizationId: org,
    },
  });
  const staff = await owner.user.create({
    data: {
      email: `csp-mgr-${suffix}@test.local`,
      name: 'Self phone manager',
      role: 'MANAGER',
      organizationId: org,
    },
  });
  await owner.team.create({
    data: { id: ids.team, name: `Self phone ${suffix}`, organizationId: org, managerId: staff.id },
  });

  const leadBase = {
    phone: PHONE,
    phoneE164: PHONE,
    source: 'WEBSITE',
    state: 'NEW' as const,
    teamId: ids.team,
    ownerId: staff.id,
    ownerType: 'MANAGER' as const,
  };
  await owner.lead.create({
    data: {
      ...leadBase,
      id: ids.lead,
      name: 'Self phone buyer',
      organizationId: org,
      projectId: ids.project,
    },
  });

  // A lead in the SECOND tenant, and a buyer in the first whose pointer names it.
  // No constraint holds User.customerLeadId inside the user's org, which is
  // exactly the hole this function has to close itself.
  const staffB = await owner.user.create({
    data: {
      email: `csp-mgrb-${suffix}@test.local`,
      name: 'Self phone manager B',
      role: 'MANAGER',
      organizationId: orgB,
    },
  });
  const projectB = await owner.project.create({
    data: {
      id: `${ids.project}b`,
      name: `Self phone B ${suffix}`,
      slug: `cspb-${suffix}`,
      address: 'x',
      organizationId: orgB,
    },
  });
  const teamB = await owner.team.create({
    data: {
      id: `${ids.team}b`,
      name: `Self phone B ${suffix}`,
      organizationId: orgB,
      managerId: staffB.id,
    },
  });
  await owner.lead.create({
    data: {
      id: ids.foreignLead,
      name: 'Self phone foreign',
      phone: FOREIGN_PHONE,
      phoneE164: FOREIGN_PHONE,
      source: 'WEBSITE',
      state: 'NEW',
      teamId: teamB.id,
      ownerId: staffB.id,
      ownerType: 'MANAGER',
      organizationId: orgB,
      projectId: projectB.id,
    },
  });

  const buyerBase = { role: 'CUSTOMER' as const, organizationId: org };
  await owner.user.create({
    data: {
      ...buyerBase,
      id: ids.buyer,
      email: `csp-buyer-${suffix}@test.local`,
      name: 'Asha',
      customerLeadId: ids.lead,
    },
  });
  // Staff carrying a lead pointer: the function must still refuse, because the
  // check is on the ACCOUNT, not on how it happens to be linked.
  await owner.user.create({
    data: {
      role: 'TELECALLER',
      organizationId: org,
      id: ids.staffWithLeadPointer,
      email: `csp-staff-${suffix}@test.local`,
      name: 'Staff with a pointer',
      customerLeadId: ids.lead,
    },
  });
  await owner.user.create({
    data: {
      ...buyerBase,
      id: ids.unlinkedBuyer,
      email: `csp-nolink-${suffix}@test.local`,
      name: 'Unlinked',
    },
  });
  await owner.user.create({
    data: {
      ...buyerBase,
      id: ids.deletedBuyer,
      email: `csp-gone-${suffix}@test.local`,
      name: 'Gone',
      customerLeadId: ids.lead,
      deletedAt: new Date(),
    },
  });
  await owner.user.create({
    data: {
      ...buyerBase,
      id: ids.foreignBuyer,
      email: `csp-foreign-${suffix}@test.local`,
      name: 'Foreign pointer',
      customerLeadId: ids.foreignLead,
    },
  });
}, 120_000);

afterAll(async () => {
  await owner.user.deleteMany({
    where: {
      id: {
        in: [
          ids.buyer,
          ids.staffWithLeadPointer,
          ids.unlinkedBuyer,
          ids.deletedBuyer,
          ids.foreignBuyer,
        ],
      },
    },
  });
  await tenant.dispose();
  await other.dispose();
  await owner.$disconnect().catch(() => undefined);
}, 120_000);

describe('customer_self_phone()', () => {
  it("returns the buyer's own number", async () => {
    expect(await phoneAs(ctx(ids.buyer, 'CUSTOMER', tenant.organizationId))).toBe(PHONE);
  });

  it('returns null with no RLS context at all', async () => {
    // The bare client has no GUCs set: this is the state any query outside
    // withRlsContext() runs in, and it must never answer with a number.
    const rows = await owner.$queryRaw<{ phone: string | null }[]>`
      SELECT customer_self_phone() AS phone`;
    expect(rows[0]?.phone ?? null).toBeNull();
  });

  it('returns null for a staff account that carries a lead pointer', async () => {
    expect(
      await phoneAs(ctx(ids.staffWithLeadPointer, 'TELECALLER', tenant.organizationId)),
    ).toBeNull();
  });

  it('returns null when the pointer names a lead in another tenant', async () => {
    expect(await phoneAs(ctx(ids.foreignBuyer, 'CUSTOMER', tenant.organizationId))).toBeNull();
  });

  it('returns null for an unlinked buyer', async () => {
    expect(await phoneAs(ctx(ids.unlinkedBuyer, 'CUSTOMER', tenant.organizationId))).toBeNull();
  });

  it('returns null for a soft-deleted account, even with a live pointer', async () => {
    expect(await phoneAs(ctx(ids.deletedBuyer, 'CUSTOMER', tenant.organizationId))).toBeNull();
  });

  it('does not answer across orgs even for the right user id', async () => {
    // Right user, wrong org in the context: the pair must agree.
    expect(await phoneAs(ctx(ids.buyer, 'CUSTOMER', other.organizationId))).toBeNull();
  });
});
