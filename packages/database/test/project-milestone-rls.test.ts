// ────────────────────────────────────────────────────────────────────────────
// ProjectMilestone RLS + Unit.expectedHandoverDate (portal redesign 2026-11-09)
// ────────────────────────────────────────────────────────────────────────────
// Migration under test: 20261109120000_portal_handover_milestones.
//
// protects= a buyer reads milestones only of a project where they hold an
//           APPROVED booking; no role but ADMIN can write them; the buyer can
//           read their own unit's expectedHandoverDate and nobody else's.
// fails_when= a customer sees another project's milestones, a MANAGER/CUSTOMER
//           insert succeeds, or the handover date leaks across units.
// no_claim= nothing about the service shaping or UI.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/index';
import { withRlsContext } from '../src/rls';
import { createDirectPrismaClient } from '../src/test-db-isolation';
import { DATABASE_AVAILABLE } from './setup';

const adminPrisma = createDirectPrismaClient();

const ORG_ID = 'ceid01lpfe1esm8jwsxid41k28'; // seeded demo org
const fid = (tag: string): string => `pm1${tag}`.padEnd(24, '0');

const MGR = fid('mgr');
const ADM = fid('adm');
const C1 = fid('cust1');
const C2 = fid('cust2');
const TEAM = fid('team');
const L1 = fid('lead1');
const L2 = fid('lead2');
const P1 = fid('proj1');
const P2 = fid('proj2');
const PH1 = fid('phase1');
const PH2 = fid('phase2');
const U1 = fid('unit1');
const U2 = fid('unit2');
const M1 = fid('mile1');
const M2 = fid('mile2');
const HANDOVER = new Date('2027-06-30T00:00:00.000Z');

const ALL_USERS = [MGR, ADM, C1, C2];

async function cleanup(): Promise<void> {
  await adminPrisma.projectMilestone.deleteMany({ where: { projectId: { in: [P1, P2] } } });
  await adminPrisma.booking.deleteMany({ where: { unitId: { in: [U1, U2] } } });
  await adminPrisma.user.updateMany({
    where: { id: { in: ALL_USERS } },
    data: { customerLeadId: null },
  });
  await adminPrisma.lead.deleteMany({ where: { id: { in: [L1, L2] } } });
  await adminPrisma.unit.deleteMany({ where: { id: { in: [U1, U2] } } });
  await adminPrisma.phase.deleteMany({ where: { id: { in: [PH1, PH2] } } });
  await adminPrisma.project.deleteMany({ where: { id: { in: [P1, P2] } } });
  await adminPrisma.team.deleteMany({ where: { id: TEAM } });
  await adminPrisma.user.deleteMany({ where: { id: { in: ALL_USERS } } });
}

async function mkUser(
  id: string,
  role: 'CUSTOMER' | 'MANAGER' | 'ADMIN',
  leadId?: string,
): Promise<void> {
  await adminPrisma.user.create({
    data: {
      id,
      email: `${id}@fixture.x`,
      name: `Name ${id.slice(3, 12)}`,
      role,
      emailVerified: true,
      organizationId: ORG_ID,
      ...(leadId === undefined ? {} : { customerLeadId: leadId }),
    },
  });
}

async function buildFixture(): Promise<void> {
  await cleanup();
  await mkUser(MGR, 'MANAGER');
  await mkUser(ADM, 'ADMIN');
  await adminPrisma.team.create({
    data: { id: TEAM, name: 'PM1 Team', managerId: MGR, organizationId: ORG_ID },
  });
  for (const [id, slug] of [
    [P1, 'pm1-p1'],
    [P2, 'pm1-p2'],
  ] as const) {
    await adminPrisma.project.create({
      data: { id, name: `Project ${slug}`, slug, address: 'x', organizationId: ORG_ID },
    });
  }
  await adminPrisma.phase.create({
    data: { id: PH1, projectId: P1, name: 'Phase 1', organizationId: ORG_ID },
  });
  await adminPrisma.phase.create({
    data: { id: PH2, projectId: P2, name: 'Phase 2', organizationId: ORG_ID },
  });
  for (const [id, phaseId, num, handover] of [
    [U1, PH1, 'PM1-A1', HANDOVER],
    [U2, PH2, 'PM1-B1', new Date('2028-01-01T00:00:00.000Z')],
  ] as const) {
    await adminPrisma.unit.create({
      data: {
        id,
        phaseId,
        unitNumber: num,
        bhk: 3,
        buildupSqft: '1000.00',
        pricePerSqft: '10000.00',
        price: '10000000.00',
        organizationId: ORG_ID,
        expectedHandoverDate: handover,
      },
    });
  }
  for (const [id, phone, projectId] of [
    [L1, '+910000300001', P1],
    [L2, '+910000300002', P2],
  ] as const) {
    await adminPrisma.lead.create({
      data: {
        id,
        name: `Lead ${phone}`,
        phone,
        ownerId: MGR,
        ownerType: 'MANAGER',
        teamId: TEAM,
        organizationId: ORG_ID,
        projectId,
      },
    });
  }
  await mkUser(C1, 'CUSTOMER', L1);
  await mkUser(C2, 'CUSTOMER', L2);
  for (const [unitId, leadId] of [
    [U1, L1],
    [U2, L2],
  ] as const) {
    await adminPrisma.booking.create({
      data: {
        id: `${unitId.slice(0, 18)}bkg`.padEnd(24, '0'),
        leadId,
        unitId,
        organizationId: ORG_ID,
        userId: MGR,
        amount: '10000000.00',
        listAmount: '10000000.00',
        status: 'APPROVED',
      },
    });
  }
  await adminPrisma.projectMilestone.create({
    data: { id: M1, projectId: P1, organizationId: ORG_ID, name: 'Slab cast', sortOrder: 1 },
  });
  await adminPrisma.projectMilestone.create({
    data: { id: M2, projectId: P2, organizationId: ORG_ID, name: 'Plinth', sortOrder: 1 },
  });
}

const asCustomer = (userId: string) => ({
  userId,
  role: 'CUSTOMER' as const,
  organizationId: ORG_ID,
});
const asRole = (userId: string, role: 'MANAGER' | 'ADMIN') => ({
  userId,
  role,
  organizationId: ORG_ID,
});

const maybe = DATABASE_AVAILABLE ? describe : describe.skip;

maybe('ProjectMilestone RLS + Unit.expectedHandoverDate', () => {
  beforeAll(buildFixture);
  afterAll(cleanup);

  it('a buyer sees only their own project milestones', async () => {
    const rows = await withRlsContext(prisma, asCustomer(C1), (tx) =>
      tx.projectMilestone.findMany(),
    );
    expect(rows.map((r) => r.id)).toEqual([M1]);
  });

  it('a second buyer sees only theirs', async () => {
    const rows = await withRlsContext(prisma, asCustomer(C2), (tx) =>
      tx.projectMilestone.findMany(),
    );
    expect(rows.map((r) => r.id)).toEqual([M2]);
  });

  it('a buyer reads their own unit handover date and no other unit', async () => {
    const rows = await withRlsContext(prisma, asCustomer(C1), (tx) =>
      tx.unit.findMany({ select: { id: true, expectedHandoverDate: true } }),
    );
    expect(rows).toEqual([{ id: U1, expectedHandoverDate: HANDOVER }]);
  });

  it('a buyer cannot write a milestone', async () => {
    await expect(
      withRlsContext(prisma, asCustomer(C1), (tx) =>
        tx.projectMilestone.create({
          data: { projectId: P1, organizationId: ORG_ID, name: 'Hack' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a MANAGER can read but not write milestones', async () => {
    const rows = await withRlsContext(prisma, asRole(MGR, 'MANAGER'), (tx) =>
      tx.projectMilestone.findMany({ where: { projectId: { in: [P1, P2] } } }),
    );
    expect(rows).toHaveLength(2);
    await expect(
      withRlsContext(prisma, asRole(MGR, 'MANAGER'), (tx) =>
        tx.projectMilestone.create({
          data: { projectId: P1, organizationId: ORG_ID, name: 'Nope' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('an ADMIN can write, and the write is visible to that project buyer', async () => {
    const created = await withRlsContext(prisma, asRole(ADM, 'ADMIN'), (tx) =>
      tx.projectMilestone.create({
        data: { projectId: P1, organizationId: ORG_ID, name: 'Handover', sortOrder: 2 },
      }),
    );
    const rows = await withRlsContext(prisma, asCustomer(C1), (tx) =>
      tx.projectMilestone.findMany({ orderBy: { sortOrder: 'asc' } }),
    );
    expect(rows.map((r) => r.id)).toEqual([M1, created.id]);
  });
});
