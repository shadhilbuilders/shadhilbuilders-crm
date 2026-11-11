// ────────────────────────────────────────────────────────────────────────────
// Issue #8 slice 2 - Customer portal RLS (DB-first isolation matrix)
// ────────────────────────────────────────────────────────────────────────────
// Spec: docs/specs/SPEC-customer-progress-slice-2.md. Migration under test:
// 20261106160000_customer_portal_slice2.
//
// Cases: isolation (5), deny-by-absence on sales tables (6), the five
// booking statuses (5), helpers fail closed (1), cross-org pointer (1),
// no write arm (1), unit_customer_user_ids exactness (1), plus the
// creator-label customer arm (2) that this slice added to a slice-1 function.
//
// Same fixture contract as progress-rls.test.ts: owner-role client for
// seeding, withRlsContext for the probes, idempotent upserts, own rows only.
// Permissive-by-absence: a denied sales table returns an EMPTY SET (asserted
// as length === 0), while an expected RLS violation asserts a thrown error.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/index';
import { withRlsContext } from '../src/rls';
import { createDirectPrismaClient } from '../src/test-db-isolation';
import { DATABASE_AVAILABLE } from './setup';

const adminPrisma = createDirectPrismaClient();

const ORG_ID = 'ceid01lpfe1esm8jwsxid41k28'; // seeded demo org
// Real cuid-shaped ids (lowercase alnum, 24 chars) - repo rule: no slugs.
const fid = (tag: string): string => `cs2${tag}`.padEnd(24, '0');

const ORG_X = fid('orgx');
const TEAM = fid('team');
const MGR = fid('mgr');
const ENG = fid('eng');
const TELE = fid('tele');
const C1 = fid('cust1');
const C1B = fid('cust1b');
const C1_DEL = fid('cust1del');
const C2 = fid('cust2');
const C_NULL = fid('custnull');
const C_XORG = fid('custxorg');

const L1 = fid('lead1');
const L2 = fid('lead2');
const LX = fid('leadx');

const P1 = fid('proj1');
const P2 = fid('proj2');
const PX = fid('projx');
const PH1 = fid('phase1');
const PH2 = fid('phase2');
const PHX = fid('phasex');

const U_APPROVED = fid('uapproved');
const U_HOLD = fid('uhold');
const U_TOKEN = fid('utoken');
const U_REJECTED = fid('urejected');
const U_CANCELLED = fid('ucancelled');
const U_OTHER = fid('uother'); // L2's approved unit, project P2
const U_FREE = fid('ufree'); // no booking at all
const U_X = fid('ux'); // org X unit, approved for LX

const STATUS_UNITS = [
  { status: 'APPROVED', unit: U_APPROVED },
  { status: 'HOLD', unit: U_HOLD },
  { status: 'TOKEN', unit: U_TOKEN },
  { status: 'REJECTED', unit: U_REJECTED },
  { status: 'CANCELLED', unit: U_CANCELLED },
] as const;

const photoOf = (unitId: string): string => `${unitId.slice(0, 18)}pho`.padEnd(24, '0');
const bookingOf = (unitId: string): string => `${unitId.slice(0, 18)}bkg`.padEnd(24, '0');
const PHOTO_APPROVED_2 = fid('photoapp2');

const ALL_UNITS = [
  U_APPROVED,
  U_HOLD,
  U_TOKEN,
  U_REJECTED,
  U_CANCELLED,
  U_OTHER,
  U_FREE,
  U_X,
];
const ALL_USERS = [MGR, ENG, TELE, C1, C1B, C1_DEL, C2, C_NULL, C_XORG];

const ctx = (userId: string, orgId: string = ORG_ID) => ({
  userId,
  role: 'CUSTOMER' as const,
  organizationId: orgId,
});

async function cleanup(): Promise<void> {
  const leadIds = [L1, L2, LX];
  await adminPrisma.auditLog.deleteMany({ where: { id: fid('audit1') } });
  await adminPrisma.reminder.deleteMany({ where: { leadId: { in: leadIds } } });
  await adminPrisma.siteVisit.deleteMany({ where: { leadId: { in: leadIds } } });
  await adminPrisma.activity.deleteMany({ where: { leadId: { in: leadIds } } });
  await adminPrisma.message.deleteMany({ where: { leadId: { in: leadIds } } });
  await adminPrisma.progressPhoto.deleteMany({ where: { unitId: { in: ALL_UNITS } } });
  await adminPrisma.booking.deleteMany({ where: { unitId: { in: ALL_UNITS } } });
  await adminPrisma.user.updateMany({
    where: { id: { in: ALL_USERS } },
    data: { customerLeadId: null },
  });
  await adminPrisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await adminPrisma.unit.deleteMany({ where: { id: { in: ALL_UNITS } } });
  await adminPrisma.phase.deleteMany({ where: { id: { in: [PH1, PH2, PHX] } } });
  await adminPrisma.project.deleteMany({ where: { id: { in: [P1, P2, PX] } } });
  await adminPrisma.team.deleteMany({ where: { id: TEAM } });
  await adminPrisma.user.deleteMany({ where: { id: { in: ALL_USERS } } });
  await adminPrisma.organization.deleteMany({ where: { id: ORG_X } });
}

async function mkUser(
  id: string,
  role: 'CUSTOMER' | 'MANAGER' | 'ENGINEER' | 'TELECALLER',
  orgId: string,
  extra: { customerLeadId?: string; deletedAt?: Date } = {},
): Promise<void> {
  await adminPrisma.user.upsert({
    where: { id },
    update: { role, ...extra },
    create: {
      id,
      email: `${id}@fixture.x`,
      name: `Name ${id.slice(3, 12)}`,
      role,
      emailVerified: true,
      organizationId: orgId,
      ...extra,
    },
  });
}

async function mkUnit(id: string, phaseId: string, orgId: string, n: string): Promise<void> {
  await adminPrisma.unit.upsert({
    where: { id },
    update: {},
    create: {
      id,
      phaseId,
      unitNumber: n,
      bhk: 3,
      buildupSqft: '1000.00',
      pricePerSqft: '10000.00',
      price: '10000000.00',
      organizationId: orgId,
    },
  });
}

async function mkBooking(
  unitId: string,
  leadId: string,
  orgId: string,
  status: 'APPROVED' | 'HOLD' | 'TOKEN' | 'REJECTED' | 'CANCELLED',
): Promise<void> {
  await adminPrisma.booking.upsert({
    where: { id: bookingOf(unitId) },
    update: { status, leadId },
    create: {
      id: bookingOf(unitId),
      leadId,
      unitId,
      organizationId: orgId,
      userId: MGR,
      amount: '10000000.00',
      listAmount: '10000000.00',
      status,
    },
  });
}

async function mkPhoto(id: string, unitId: string, phaseId: string, orgId: string): Promise<void> {
  await adminPrisma.progressPhoto.upsert({
    where: { id },
    update: {},
    create: {
      id,
      unitId,
      phaseId,
      organizationId: orgId,
      key: `progress/${id}.jpg`,
      mimeType: 'image/jpeg',
      filename: `${id}.jpg`,
      caption: `caption ${id}`,
      takenAt: new Date('2026-10-26T10:00:00Z'),
      createdBy: orgId === ORG_ID ? ENG : null,
    },
  });
}

async function buildFixture(): Promise<void> {
  await cleanup(); // a crashed earlier run must not poison this one

  await adminPrisma.organization.create({
    data: { id: ORG_X, name: 'Fixture Org X', slug: `cs2-orgx-${ORG_X}` },
  });

  await mkUser(MGR, 'MANAGER', ORG_ID);
  await mkUser(ENG, 'ENGINEER', ORG_ID);
  await mkUser(TELE, 'TELECALLER', ORG_ID);
  await adminPrisma.team.create({
    data: { id: TEAM, name: 'CS2 Team', managerId: MGR, organizationId: ORG_ID },
  });
  await adminPrisma.team.update({ where: { id: TEAM }, data: { managerId: MGR } });

  for (const [id, slug] of [
    [P1, 'cs2-p1'],
    [P2, 'cs2-p2'],
  ] as const) {
    await adminPrisma.project.create({
      data: { id, name: `Project ${slug}`, slug, address: 'x', organizationId: ORG_ID },
    });
  }
  await adminPrisma.project.create({
    data: { id: PX, name: 'Project X', slug: 'cs2-px', address: 'x', organizationId: ORG_X },
  });
  await adminPrisma.phase.create({ data: { id: PH1, projectId: P1, name: 'Phase 1', organizationId: ORG_ID } });
  await adminPrisma.phase.create({ data: { id: PH2, projectId: P2, name: 'Phase 2', organizationId: ORG_ID } });
  await adminPrisma.phase.create({ data: { id: PHX, projectId: PX, name: 'Phase X', organizationId: ORG_X } });

  for (const [id, num] of [
    [U_APPROVED, 'CS2-A1'],
    [U_HOLD, 'CS2-H1'],
    [U_TOKEN, 'CS2-T1'],
    [U_REJECTED, 'CS2-R1'],
    [U_CANCELLED, 'CS2-C1'],
    [U_FREE, 'CS2-F1'],
  ] as const) {
    await mkUnit(id, PH1, ORG_ID, num);
  }
  await mkUnit(U_OTHER, PH2, ORG_ID, 'CS2-O1');
  await mkUnit(U_X, PHX, ORG_X, 'CS2-X1');

  const mkLead = (id: string, phone: string, projectId: string, orgId: string) =>
    adminPrisma.lead.create({
      data: {
        id,
        name: `Lead ${phone}`,
        phone,
        ownerId: MGR,
        ownerType: 'MANAGER',
        teamId: TEAM,
        organizationId: orgId,
        projectId,
      },
    });
  await mkLead(L1, '+910000200001', P1, ORG_ID);
  await mkLead(L2, '+910000200002', P2, ORG_ID);
  await mkLead(LX, '+910000200003', PX, ORG_X);

  await mkUser(C1, 'CUSTOMER', ORG_ID, { customerLeadId: L1 });
  await mkUser(C1B, 'CUSTOMER', ORG_ID, { customerLeadId: L1 }); // joint buyer, same lead (D2)
  await mkUser(C1_DEL, 'CUSTOMER', ORG_ID, { customerLeadId: L1, deletedAt: new Date() });
  await mkUser(C2, 'CUSTOMER', ORG_ID, { customerLeadId: L2 });
  await mkUser(C_NULL, 'CUSTOMER', ORG_ID); // no pointer: not provisioned
  await mkUser(C_XORG, 'CUSTOMER', ORG_ID, { customerLeadId: LX }); // pointer into ANOTHER org
  // A staff user that (wrongly) carries a pointer: helpers must ignore it.
  await adminPrisma.user.update({ where: { id: TELE }, data: { customerLeadId: L1 } });

  for (const { status, unit } of STATUS_UNITS) {
    await mkBooking(unit, L1, ORG_ID, status);
    await mkPhoto(photoOf(unit), unit, PH1, ORG_ID);
  }
  await mkPhoto(PHOTO_APPROVED_2, U_APPROVED, PH1, ORG_ID);
  await mkBooking(U_OTHER, L2, ORG_ID, 'APPROVED');
  await mkPhoto(photoOf(U_OTHER), U_OTHER, PH2, ORG_ID);
  await mkBooking(U_X, LX, ORG_X, 'APPROVED');
  await mkPhoto(photoOf(U_X), U_X, PHX, ORG_X);

  // Sales-table rows the customer must NEVER see (against L1, the lead they own).
  await adminPrisma.message.create({
    data: {
      id: fid('msg1'),
      leadId: L1,
      organizationId: ORG_ID,
      userId: MGR,
      direction: 'OUT',
      channel: 'IN_APP',
      body: 'internal',
    },
  });
  await adminPrisma.activity.create({
    data: { id: fid('act1'), leadId: L1, organizationId: ORG_ID, userId: MGR, type: 'NOTE', body: 'internal' },
  });
  await adminPrisma.siteVisit.create({
    data: { id: fid('visit1'), leadId: L1, organizationId: ORG_ID, userId: MGR, scheduledFor: new Date() },
  });
  await adminPrisma.reminder.create({
    data: {
      id: fid('rem1'),
      leadId: L1,
      organizationId: ORG_ID,
      userId: MGR,
      type: 'PRE_VISIT_STAFF',
      scheduledFor: new Date(),
    },
  });
  await adminPrisma.auditLog.create({
    data: {
      id: fid('audit1'),
      userId: MGR,
      organizationId: ORG_ID,
      action: 'booking.approve',
      entityType: 'Booking',
      entityId: bookingOf(U_APPROVED),
    },
  });
}

const maybe = DATABASE_AVAILABLE ? describe : describe.skip;

const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id).sort();

maybe('Customer portal RLS (issue #8 slice 2)', () => {
  beforeAll(buildFixture);
  afterAll(cleanup);

  // ── Isolation (5) ──────────────────────────────────────────────────────
  // protects=a customer reads only rows tied to their own APPROVED unit;
  // fails_when=a policy leaks another buyer's/lead's rows or an unapproved unit;
  // no_claim=nothing about the service layer or UI.
  describe('isolation', () => {
    it('Unit: C1 sees exactly the one APPROVED unit', async () => {
      const rows = await withRlsContext(prisma, ctx(C1), (tx) => tx.unit.findMany());
      expect(ids(rows)).toEqual([U_APPROVED]);
    });

    it('Phase: C1 sees exactly the phase of that unit', async () => {
      const rows = await withRlsContext(prisma, ctx(C1), (tx) => tx.phase.findMany());
      expect(ids(rows)).toEqual([PH1]);
    });

    it('Project: C1 sees exactly the project of that unit', async () => {
      const rows = await withRlsContext(prisma, ctx(C1), (tx) => tx.project.findMany());
      expect(ids(rows)).toEqual([P1]);
    });

    it('ProgressPhoto: C1 sees only the two photos on the APPROVED unit; C2 sees only theirs', async () => {
      const c1 = await withRlsContext(prisma, ctx(C1), (tx) => tx.progressPhoto.findMany());
      expect(ids(c1)).toEqual([photoOf(U_APPROVED), PHOTO_APPROVED_2].sort());
      const c2 = await withRlsContext(prisma, ctx(C2), (tx) => tx.progressPhoto.findMany());
      expect(ids(c2)).toEqual([photoOf(U_OTHER)]);
    });

    it('Booking: C1 sees only the APPROVED booking on their own lead', async () => {
      const rows = await withRlsContext(prisma, ctx(C1), (tx) => tx.booking.findMany());
      expect(ids(rows)).toEqual([bookingOf(U_APPROVED)]);
    });
  });

  // ── Deny by absence (6) ────────────────────────────────────────────────
  // protects=CUSTOMER has no arm on sales tables, even for rows of its own lead;
  // fails_when=any customer arm is added to these tables (rows appear);
  // no_claim=this is an EMPTY SET by absence, not an error: services must not read it as "no data".
  describe('sales tables return an empty set', () => {
    const cases: [string, (tx: typeof prisma) => Promise<unknown[]>][] = [
      ['Lead', (tx) => tx.lead.findMany()],
      ['Message', (tx) => tx.message.findMany()],
      ['Activity', (tx) => tx.activity.findMany()],
      ['SiteVisit', (tx) => tx.siteVisit.findMany()],
      ['Reminder', (tx) => tx.reminder.findMany()],
      ['AuditLog', (tx) => tx.auditLog.findMany()],
    ];
    it.each(cases)('%s: length 0 for C1', async (_name, read) => {
      const rows = await withRlsContext(prisma, ctx(C1), (tx) => read(tx as unknown as typeof prisma));
      expect(rows.length).toBe(0);
    });
  });

  // ── Five booking statuses (5) ──────────────────────────────────────────
  // protects=only APPROVED opens the portal (D4);
  // fails_when=HOLD/TOKEN/REJECTED/CANCELLED exposes unit, photos or booking;
  // no_claim=nothing about status transitions.
  describe('booking status gates access', () => {
    it.each(STATUS_UNITS.map((s) => [s.status, s.unit] as const))(
      '%s booking: portal rows visible iff APPROVED',
      async (status, unit) => {
        const open = status === 'APPROVED';
        const { units, photos, bookings } = await withRlsContext(prisma, ctx(C1), async (tx) => ({
          units: await tx.unit.findMany({ where: { id: unit } }),
          photos: await tx.progressPhoto.findMany({ where: { unitId: unit } }),
          bookings: await tx.booking.findMany({ where: { unitId: unit } }),
        }));
        expect(units.length).toBe(open ? 1 : 0);
        expect(photos.length).toBe(open ? (unit === U_APPROVED ? 2 : 1) : 0);
        expect(bookings.length).toBe(open ? 1 : 0);
      },
    );
  });

  // protects=helpers fail closed with no RLS context; fails_when=a helper returns
  // a row/true without GUCs; no_claim=says nothing about a valid context.
  it('helpers fail closed without GUCs', async () => {
    const lead = await prisma.$queryRaw<{ v: string | null }[]>`SELECT customer_lead_id() AS v`;
    const can = await prisma.$queryRaw<{ v: boolean }[]>`SELECT customer_can_read_unit(${U_APPROVED}) AS v`;
    const users = await prisma.$queryRaw<unknown[]>`SELECT unit_customer_user_ids(${U_APPROVED})`;
    const label = await prisma.$queryRaw<unknown[]>`SELECT * FROM progress_photo_creator_label(${photoOf(U_APPROVED)})`;
    expect(lead[0]?.v).toBeNull();
    expect(can[0]?.v).toBe(false);
    expect(users.length).toBe(0);
    expect(label.length).toBe(0);
  });

  // protects=a pointer into another org grants nothing, in either direction;
  // fails_when=the org predicate is dropped from a helper or policy;
  // no_claim=assumes the pointer was written by a privileged path (FK allows it).
  it('cross-org pointer: customer pointing at another org lead sees nothing', async () => {
    const own = await withRlsContext(prisma, ctx(C_XORG), async (tx) => ({
      units: await tx.unit.findMany(),
      photos: await tx.progressPhoto.findMany(),
      bookings: await tx.booking.findMany(),
    }));
    expect(own).toEqual({ units: [], photos: [], bookings: [] });
    // Claiming org X for a user who lives in org A also fails closed.
    const claimed = await withRlsContext(prisma, ctx(C_XORG, ORG_X), async (tx) => ({
      units: await tx.unit.findMany(),
      photos: await tx.progressPhoto.findMany(),
    }));
    expect(claimed).toEqual({ units: [], photos: [] });
  });

  // protects=CUSTOMER is read-only (D5); fails_when=any write arm exists;
  // no_claim=UPDATE/DELETE are silent 0-row no-ops under RLS (verified via owner client), INSERT throws.
  it('no write arm: inserts throw, updates and deletes touch nothing', async () => {
    await expect(
      withRlsContext(prisma, ctx(C1), (tx) =>
        tx.progressPhoto.create({
          data: {
            unitId: U_APPROVED,
            organizationId: ORG_ID,
            key: 'k',
            mimeType: 'image/jpeg',
            filename: 'f.jpg',
            caption: 'c',
            takenAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withRlsContext(prisma, ctx(C1), (tx) =>
        tx.booking.create({
          data: {
            leadId: L1,
            unitId: U_FREE,
            organizationId: ORG_ID,
            userId: MGR,
            amount: '1',
            listAmount: '1',
          },
        }),
      ),
    ).rejects.toThrow();

    const upd = await withRlsContext(prisma, ctx(C1), (tx) =>
      tx.progressPhoto.updateMany({ where: { unitId: U_APPROVED }, data: { caption: 'hacked' } }),
    );
    const del = await withRlsContext(prisma, ctx(C1), (tx) =>
      tx.progressPhoto.deleteMany({ where: { unitId: U_APPROVED } }),
    );
    const bupd = await withRlsContext(prisma, ctx(C1), (tx) =>
      tx.booking.updateMany({ where: { id: bookingOf(U_APPROVED) }, data: { status: 'CANCELLED' } }),
    );
    expect([upd.count, del.count, bupd.count]).toEqual([0, 0, 0]);

    const photos = await adminPrisma.progressPhoto.findMany({ where: { unitId: U_APPROVED } });
    expect(photos.length).toBe(2);
    expect(photos.every((p) => p.caption.startsWith('caption '))).toBe(true);
    const booking = await adminPrisma.booking.findUnique({ where: { id: bookingOf(U_APPROVED) } });
    expect(booking?.status).toBe('APPROVED');
  });

  // protects=PortalNotifier recipient set is exactly live customers of an APPROVED booking in the org;
  // fails_when=it includes a deleted login, a staff user with a stray pointer, another lead's buyer,
  //   a non-APPROVED unit's buyer, or another org;
  // no_claim=does not prove push delivery.
  it('unit_customer_user_ids returns exactly the live approved customers, org-scoped', async () => {
    const svc = (org: string) => ({ userId: 'portal-notifier', role: 'CRON_SERVICE' as const, organizationId: org });
    const call = async (org: string, unit: string): Promise<string[]> =>
      (
        await withRlsContext(prisma, svc(org), (tx) =>
          tx.$queryRaw<{ id: string }[]>`SELECT unit_customer_user_ids(${unit}) AS id`,
        )
      )
        .map((r) => r.id)
        .sort();

    expect(await call(ORG_ID, U_APPROVED)).toEqual([C1, C1B].sort());
    expect(await call(ORG_ID, U_HOLD)).toEqual([]);
    expect(await call(ORG_ID, U_FREE)).toEqual([]);
    expect(await call(ORG_ID, U_OTHER)).toEqual([C2]);
    expect(await call(ORG_X, U_APPROVED)).toEqual([]); // wrong org for that unit
    expect(await call(ORG_ID, U_X)).toEqual([]); // other org's unit from org A context
  });

  // protects=the customer arm added to progress_photo_creator_label() in this migration;
  // fails_when=a customer cannot read the uploader name on their unit, or can on someone else's;
  // no_claim=existing staff branches are covered by progress-rls.test.ts / service tests.
  describe('creator label customer arm', () => {
    it('own APPROVED unit: returns the uploader name', async () => {
      const rows = await withRlsContext(prisma, ctx(C1), (tx) =>
        tx.$queryRaw<{ creator_name: string | null }[]>`
          SELECT * FROM progress_photo_creator_label(${photoOf(U_APPROVED)})`,
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.creator_name).toBeTruthy();
    });

    it("another buyer's / unapproved unit: returns nothing", async () => {
      for (const unit of [U_OTHER, U_HOLD]) {
        const rows = await withRlsContext(prisma, ctx(C1), (tx) =>
          tx.$queryRaw<unknown[]>`SELECT * FROM progress_photo_creator_label(${photoOf(unit)})`,
        );
        expect(rows.length).toBe(0);
      }
    });
  });
});
