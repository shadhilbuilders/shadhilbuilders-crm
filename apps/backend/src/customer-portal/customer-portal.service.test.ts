// Customer portal service (issue #8 slice 2) - authorization matrix, `me`
// shaping, and timeline parity with the staff route.
//
// protects= the four service decisions RLS cannot make (RLS answers with an
//           empty set): staff 403, unlinked 403 (with the office phone),
//           foreign unit 404, own unit 200; plus `me` ordering/empty shape and
//           that the buyer timeline is byte-identical to the staff timeline.
// fails_when= a role/pointer/booking check is skipped, a foreign unit answers
//           403 instead of 404, `me` mis-sorts natural unit numbers, or the
//           two timelines drift (order, page size, cursor, DTO shape).
// no_claim= does NOT touch a real database: RLS itself is owned by
//           packages/database/test/customer-portal-rls.test.ts. The tx is a
//           fake, so a green run says nothing about policy behaviour.
import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

vi.mock('@shadhil/database', () => ({
  rlsContextFrom: vi.fn((a: { sub: string; role: string; organizationId: string }) => ({
    userId: a.sub,
    role: a.role,
    organizationId: a.organizationId,
  })),
  withRlsContext: vi.fn(async (_c: unknown, _ctx: unknown, cb: (t: unknown) => unknown) =>
    cb((globalThis as { __tx?: unknown }).__tx),
  ),
}));

import { CustomerProgressService } from '../customer-progress/customer-progress.service';
import { CustomerPortalService, NOT_LINKED_CODE, compareUnits } from './customer-portal.service';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const NOW = Math.floor(Date.now() / 1000);
const actor = (role: JwtPayload['role'], sub = 'u-1'): JwtPayload => ({
  sub,
  email: `${sub}@x.in`,
  role,
  organizationId: ORG,
  iat: NOW,
  exp: NOW + 3600,
  iss: 'shadhil-bff',
});

const prismaStub = { $client: {} } as never;
const setTx = (tx: unknown) => {
  (globalThis as { __tx?: unknown }).__tx = tx;
};

function photoRows(n: number) {
  // newest first, 1 minute apart, ids descending
  return Array.from({ length: n }, (_, i) => ({
    id: `photo-${String(1000 - i)}`,
    unitId: 'unit-1',
    phaseId: 'ph-1',
    phase: { name: 'Foundation' },
    mimeType: 'image/jpeg',
    filename: `f${i}.jpg`,
    caption: `Foundation October 2026 #${i}`,
    takenAt: new Date(Date.UTC(2026, 9, 26, 12, 0) - i * 60_000),
    createdAt: new Date(Date.UTC(2026, 9, 26, 12, 5)),
    key: `progress/k${i}.jpg`,
  }));
}

function baseTx(overrides: Record<string, unknown> = {}) {
  const findMany = vi.fn(async () => photoRows(51));
  return {
    user: {
      findUnique: vi.fn(async () => ({
        name: 'Asha Rao',
        customerLeadId: 'lead-1',
        deletedAt: null,
      })),
    },
    organization: { findUnique: vi.fn(async () => ({ contactPhone: '+91 98765 43210' })) },
    booking: {
      findFirst: vi.fn(async () => ({ id: 'bk-1' })),
      findMany: vi.fn(async () => []),
    },
    progressPhoto: { findMany, groupBy: vi.fn(async () => []) },
    unit: {
      findFirst: vi.fn(async () => ({
        id: 'unit-1',
        unitNumber: 'A-1',
        phase: { projectId: 'p-1' },
      })),
    },
    projectMilestone: { findMany: vi.fn(async () => []) },
    // The staff timeline reads PHOTO_LEAD to compute the advisory canMutate
    // flag (slice 4). A buyer's context has no ProjectStaffRole row, and the
    // parity test compares the two responses, so this must return null.
    projectStaffRole: { findFirst: vi.fn(async () => null) },
    // Two different raw queries reach the transaction: the buyer's own phone
    // (customer_self_phone, 2026-11-26) and the creator labels on the timeline.
    // The fake answers by SQL, so a swap between them cannot pass unnoticed.
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      strings.join('').includes('customer_self_phone')
        ? [{ phone: '919876543210' }]
        : [{ creator_name: 'Ravi', creator_is_photo_lead: false }],
    ),
    ...overrides,
  };
}

describe('CustomerPortalService authorization (4 exact assertions)', () => {
  let svc: CustomerPortalService;
  beforeEach(() => {
    svc = new CustomerPortalService(prismaStub);
    setTx(baseTx());
  });

  it('403 for a staff role', async () => {
    await expect(svc.me(actor('MANAGER'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.timeline(actor('ADMIN'), 'unit-1', undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('403 CUSTOMER_NOT_LINKED (with the office phone) for a null pointer', async () => {
    setTx(
      baseTx({
        user: {
          findUnique: vi.fn(async () => ({ name: 'Asha', customerLeadId: null, deletedAt: null })),
        },
      }),
    );
    for (const call of [
      () => svc.me(actor('CUSTOMER')),
      () => svc.timeline(actor('CUSTOMER'), 'unit-1', undefined),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(403);
      const body = (err as HttpException).getResponse() as {
        code: string;
        details: { officePhone: string };
      };
      expect(body.code).toBe(NOT_LINKED_CODE);
      expect(body.details.officePhone).toBe('+91 98765 43210');
    }
  });

  it('404 (not 403) for a unit outside the caller APPROVED bookings', async () => {
    setTx(baseTx({ booking: { findFirst: vi.fn(async () => null), findMany: vi.fn() } }));
    await expect(
      svc.timeline(actor('CUSTOMER'), 'someone-elses', undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('200 for an own unit, and the lookup is pinned to APPROVED + own lead', async () => {
    const tx = baseTx();
    setTx(tx);
    const res = await svc.timeline(actor('CUSTOMER'), 'unit-1', undefined);
    expect(res.photos.length).toBe(50);
    expect(tx.booking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { unitId: 'unit-1', leadId: 'lead-1', organizationId: ORG, status: 'APPROVED' },
      }),
    );
  });
});

describe('me', () => {
  const unitRow = (
    id: string,
    unitNumber: string,
    project: string,
    handover: Date | null = null,
    over: Partial<{
      plotNumber: number | null;
      bhk: number;
      facing: string | null;
      sqft: number | null;
      buildupSqft: string;
      pricePerSqft: string;
      price: string;
      phaseName: string | null;
      listAmount: string;
      negotiatedRate: string | null;
      negotiatedAmount: string | null;
      amount: string;
      tokenAmount: string | null;
    }> = {},
  ) => ({
    // Money lives on the BOOKING (audit baseline + agreed terms); physical
    // facts live on the UNIT. The service reads both.
    listAmount: { toString: () => over.listAmount ?? '4380000.00' },
    negotiatedRate: over.negotiatedRate ? { toString: () => over.negotiatedRate } : null,
    negotiatedAmount: over.negotiatedAmount ? { toString: () => over.negotiatedAmount } : null,
    amount: {
      toString: () => over.amount ?? over.negotiatedAmount ?? over.listAmount ?? '4380000.00',
    },
    tokenAmount: over.tokenAmount ? { toString: () => over.tokenAmount } : null,
    unit: {
      id,
      unitNumber,
      expectedHandoverDate: handover,
      plotNumber: over.plotNumber ?? null,
      bhk: over.bhk ?? 2,
      facing: over.facing ?? null,
      sqft: over.sqft ?? null,
      buildupSqft: { toString: () => over.buildupSqft ?? '1090.00' },
      pricePerSqft: { toString: () => over.pricePerSqft ?? '4018.35' },
      price: { toString: () => over.price ?? '4380000.00' },
      phase: {
        name: over.phaseName ?? null,
        project: { id: `p-${project}`, name: project },
      },
    },
  });

  it("carries the buyer's own phone, read through customer_self_phone()", async () => {
    const tx = baseTx({
      booking: { findFirst: vi.fn(), findMany: vi.fn(async () => [unitRow('u1', 'A-1', 'Metro')]) },
    });
    setTx(tx);

    const me = await new CustomerPortalService(prismaStub).me(actor('CUSTOMER'));

    expect(me.phone).toBe('919876543210');
    // One column, one caller: the read goes through the SECURITY DEFINER lookup
    // rather than a Lead query, which a CUSTOMER session has no policy for.
    expect(tx.$queryRaw).toHaveBeenCalled();
    const sql = String((tx.$queryRaw.mock.calls[0] as [TemplateStringsArray])[0].join(''));
    expect(sql).toContain('customer_self_phone');
  });

  it('answers phone: null when the lookup returns nothing, not an empty string', async () => {
    const tx = baseTx({
      booking: { findFirst: vi.fn(), findMany: vi.fn(async () => [unitRow('u1', 'A-1', 'Metro')]) },
      $queryRaw: vi.fn(async () => []),
    });
    setTx(tx);

    const me = await new CustomerPortalService(prismaStub).me(actor('CUSTOMER'));

    expect(me.phone).toBeNull();
  });

  it('sorts by project name then natural unit number, with count + current phase', async () => {
    const tx = baseTx({
      booking: {
        findFirst: vi.fn(),
        findMany: vi.fn(async () => [
          unitRow('u10', 'A-10', 'Metro Heights'),
          unitRow('u2', 'A-2', 'Metro Heights'),
          unitRow('ux', 'B-1', 'Aster Court'),
        ]),
      },
      progressPhoto: {
        findMany: vi.fn(async () => [{ unitId: 'u2', phase: { name: 'Plinth' } }]),
        groupBy: vi.fn(async () => [{ unitId: 'u2', _count: { _all: 7 } }]),
      },
    });
    setTx(tx);
    const res = await new CustomerPortalService(prismaStub).me(actor('CUSTOMER'));
    expect(res.customerName).toBe('Asha Rao');
    expect(res.units.map((u) => u.unitNumber)).toEqual(['B-1', 'A-2', 'A-10']);
    expect(res.units[1]).toEqual({
      unitId: 'u2',
      unitNumber: 'A-2',
      projectName: 'Metro Heights',
      projectId: 'p-Metro Heights',
      currentPhaseName: 'Plinth',
      photoCount: 7,
      expectedHandoverDate: null,
      milestones: [],
      // Unit record + this buyer's terms.
      plotNumber: null,
      bhk: 2,
      facing: null,
      plotSqft: null,
      buildupSqft: '1090.00',
      pricePerSqft: '4018.35',
      listAmount: '4380000.00',
      phaseName: null,
      negotiatedRate: null,
      negotiatedAmount: null,
      finalAmount: '4380000.00',
      isNegotiated: false,
      tokenAmount: null,
    });
    expect(res.units[2]).toMatchObject({ currentPhaseName: null, photoCount: 0 });
  });

  // 2026-11-09: the buyer's own commercial record. Every figure the office
  // quotes on the phone must be on their screen, with the AMOUNT THEY PAY
  // stated explicitly and the list vs negotiated split kept honest.
  it('exposes the unit record and the amount the buyer actually pays', async () => {
    const tx = baseTx({
      booking: {
        findFirst: vi.fn(),
        findMany: vi.fn(async () => [
          unitRow('u1', 'A-101', 'Shadhil Metro Heights', null, {
            plotNumber: 41,
            bhk: 2,
            facing: 'North',
            sqft: 1090,
            buildupSqft: '1090.00',
            pricePerSqft: '4018.35',
            price: '4380000.00',
            phaseName: 'Phase C',
            listAmount: '4380000.00',
          }),
        ]),
      },
    });
    setTx(tx);
    const res = await new CustomerPortalService(prismaStub).me(actor('CUSTOMER'));
    expect(res.units[0]).toMatchObject({
      unitNumber: 'A-101',
      plotNumber: 41,
      bhk: 2,
      facing: 'North',
      plotSqft: 1090,
      buildupSqft: '1090.00',
      pricePerSqft: '4018.35',
      listAmount: '4380000.00',
      phaseName: 'Phase C',
      // Nothing negotiated: the buyer pays the list total.
      negotiatedRate: null,
      negotiatedAmount: null,
      finalAmount: '4380000.00',
      isNegotiated: false,
      tokenAmount: null,
    });
  });

  it('exposes the token received so the portal can show the balance due', async () => {
    const tx = baseTx({
      booking: {
        findFirst: vi.fn(),
        findMany: vi.fn(async () => [
          unitRow('u1', 'A-101', 'Shadhil Metro Heights', null, {
            listAmount: '4380000.00',
            tokenAmount: '500000.00',
          }),
        ]),
      },
    });
    setTx(tx);
    const res = await new CustomerPortalService(prismaStub).me(actor('CUSTOMER'));
    expect(res.units[0]).toMatchObject({
      finalAmount: '4380000.00',
      tokenAmount: '500000.00',
    });
  });

  it('reports a negotiated deal without hiding the list total', async () => {
    const tx = baseTx({
      booking: {
        findFirst: vi.fn(),
        findMany: vi.fn(async () => [
          unitRow('u1', 'A-101', 'Shadhil Metro Heights', null, {
            listAmount: '4380000.00',
            negotiatedRate: '3900.00',
            negotiatedAmount: '4251000.00',
            amount: '4251000.00',
          }),
        ]),
      },
    });
    setTx(tx);
    const res = await new CustomerPortalService(prismaStub).me(actor('CUSTOMER'));
    expect(res.units[0]).toMatchObject({
      // Both numbers survive: the buyer can see what they saved.
      listAmount: '4380000.00',
      negotiatedRate: '3900.00',
      negotiatedAmount: '4251000.00',
      finalAmount: '4251000.00',
      isNegotiated: true,
    });
  });

  it("carries the handover date and only the unit's own project milestones, in staff order", async () => {
    const tx = baseTx({
      booking: {
        findFirst: vi.fn(),
        findMany: vi.fn(async () => [
          unitRow('u1', 'A-1', 'Metro Heights', new Date(Date.UTC(2027, 5, 30))),
          unitRow('u2', 'B-1', 'Aster Court'),
        ]),
      },
      projectMilestone: {
        findMany: vi.fn(async () => [
          {
            id: 'm1',
            projectId: 'p-Metro Heights',
            name: 'Slab cast',
            targetDate: new Date(Date.UTC(2027, 0, 15)),
            completedAt: new Date(Date.UTC(2027, 0, 10)),
          },
          {
            id: 'm2',
            projectId: 'p-Metro Heights',
            name: 'Handover',
            targetDate: null,
            completedAt: null,
          },
        ]),
      },
    });
    setTx(tx);
    const res = await new CustomerPortalService(prismaStub).me(actor('CUSTOMER'));
    const metro = res.units.find((u) => u.unitId === 'u1')!;
    expect(metro.expectedHandoverDate).toBe('2027-06-30T00:00:00.000Z');
    expect(metro.milestones).toEqual([
      {
        id: 'm1',
        name: 'Slab cast',
        targetDate: '2027-01-15T00:00:00.000Z',
        completedAt: '2027-01-10T00:00:00.000Z',
      },
      { id: 'm2', name: 'Handover', targetDate: null, completedAt: null },
    ]);
    // Aster Court has no milestones and no handover date: both are empty, never guessed.
    const aster = res.units.find((u) => u.unitId === 'u2')!;
    expect(aster.expectedHandoverDate).toBeNull();
    expect(aster.milestones).toEqual([]);
    expect(tx.projectMilestone.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: { in: expect.arrayContaining(['p-Metro Heights', 'p-Aster Court']) },
          organizationId: ORG,
        },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('returns an empty list (not an error) for a provisioned customer with no APPROVED booking', async () => {
    setTx(baseTx());
    const res = await new CustomerPortalService(prismaStub).me(actor('CUSTOMER'));
    // The empty-bookings path must still carry the person's own details: a buyer
    // whose unit is not approved yet can still be told which number we hold.
    expect(res).toEqual({ customerName: 'Asha Rao', phone: '919876543210', units: [] });
  });

  it('compareUnits is natural, not lexicographic', () => {
    const mk = (unitNumber: string) => ({ unitNumber, projectName: 'P' }) as never;
    expect(compareUnits(mk('A-2'), mk('A-10'))).toBeLessThan(0);
  });
});

describe('timeline parity with the staff route', () => {
  it('buyer and staff timelines return the identical page, order and cursor', async () => {
    const tx = baseTx();
    setTx(tx);
    const storage = { save: vi.fn(), delete: vi.fn() } as never;
    const staff = new CustomerProgressService(prismaStub, storage);
    const portal = new CustomerPortalService(prismaStub);

    const staffPage1 = await staff.timeline(actor('ADMIN', 'admin-1'), 'unit-1', undefined);
    const portalPage1 = await portal.timeline(actor('CUSTOMER'), 'unit-1', undefined);

    // PARITY IS ABOUT CONTENT, NOT CAPABILITY. The two surfaces must agree on
    // which photos exist, their order, their captions and the cursor - that is
    // what makes the staff preview trustworthy as a preview of the buyer's
    // view. `canMutate` is deliberately viewer-relative (an admin may correct a
    // photo, a buyer may not), so it is excluded here and asserted separately
    // below. Same key set, different value where the capability legitimately
    // differs.
    const content = (page: typeof portalPage1) => ({
      nextCursor: page.nextCursor,
      photos: page.photos.map(({ canMutate: _canMutate, ...rest }) => rest),
    });
    expect(content(portalPage1)).toEqual(content(staffPage1));
    expect(portalPage1.photos.length).toBe(50);
    expect(portalPage1.nextCursor).not.toBeNull();

    // Both asked the DB the same question: stable composite order, 51 rows.
    const calls = tx.progressPhoto.findMany.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
    expect(calls[0]?.[0]).toMatchObject({
      orderBy: [{ takenAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });

    // The cursor from page 1 drives the SAME keyset predicate on page 2.
    tx.progressPhoto.findMany.mockClear();
    await portal.timeline(actor('CUSTOMER'), 'unit-1', portalPage1.nextCursor!);
    const where = (
      tx.progressPhoto.findMany.mock.calls[0] as unknown as [{ where: { OR: unknown[] } }]
    )[0].where;
    expect(where.OR).toHaveLength(2);

    // Same DTO keys on both surfaces - a field present for staff and missing
    // for a buyer would be a wire-shape drift.
    const keys = (p: (typeof portalPage1)['photos'][number]) => Object.keys(p).sort();
    expect(keys(portalPage1.photos[0]!)).toEqual(keys(staffPage1.photos[0]!));

    // The capability itself: admin may correct, buyer never may.
    expect(staffPage1.photos.every((p) => p.canMutate === true)).toBe(true);
    expect(portalPage1.photos.every((p) => p.canMutate === false)).toBe(true);
  });
});

// ── Stage grouping (2026-11-25) ─────────────────────────────────────────────
//
// protects= the buyer's feed can be narrowed to one stage through the API, the
//           chips' totals come from the server with the SAME filter as the feed,
//           null-stage captures land in their own `unset` bucket rather than in
//           NOT_STARTED, and both reads still refuse a unit that is not theirs;
// fails_when= the stage rides along as a client-side filter (server where clause
//           untouched), `unset` is folded into a stage total, the totals use a
//           different where clause than the feed, or the stage endpoints skip the
//           booking check;
// no_claim= the controller's query-string parsing (parseStageFilter unit test)
//           and the rendered chips (web tests).
describe('stage filtering and totals', () => {
  it('narrows the feed on the server when a stage is given', async () => {
    const tx = baseTx({});
    setTx(tx);
    const portal = new CustomerPortalService(prismaStub);
    await portal.timeline(actor('CUSTOMER'), 'unit-1', undefined, 'PLASTERING');
    const where = (
      tx.progressPhoto.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0].where;
    expect(where).toMatchObject({ unitId: 'unit-1', stage: 'PLASTERING' });
  });

  it('asks for stage: null for the UNSET bucket, which is not NOT_STARTED', async () => {
    const tx = baseTx({});
    setTx(tx);
    const portal = new CustomerPortalService(prismaStub);
    await portal.timeline(actor('CUSTOMER'), 'unit-1', undefined, 'UNSET');
    const where = (
      tx.progressPhoto.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0].where;
    expect(where['stage']).toBeNull();
  });

  it('keeps the historical query exactly when no stage is given', async () => {
    const tx = baseTx({});
    setTx(tx);
    const portal = new CustomerPortalService(prismaStub);
    await portal.timeline(actor('CUSTOMER'), 'unit-1', undefined);
    const where = (
      tx.progressPhoto.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0].where;
    expect('stage' in where).toBe(false);
  });

  it('counts each stage, keeps unset apart, and sorts in build order', async () => {
    const tx = baseTx({
      progressPhoto: {
        findMany: vi.fn(async () => []),
        groupBy: vi.fn(async () => [
          { stage: 'PLASTERING', _count: { _all: 6 } },
          { stage: null, _count: { _all: 3 } },
          { stage: 'FOUNDATION', _count: { _all: 8 } },
          { stage: 'STRUCTURE', _count: { _all: 24 } },
        ]),
      },
    });
    setTx(tx);
    const portal = new CustomerPortalService(prismaStub);
    const counts = await portal.stageCounts(actor('CUSTOMER'), 'unit-1');
    expect(counts.stages).toEqual([
      { stage: 'FOUNDATION', count: 8 },
      { stage: 'STRUCTURE', count: 24 },
      { stage: 'PLASTERING', count: 6 },
    ]);
    expect(counts.unset).toBe(3);
    expect(counts.total).toBe(41);

    // Same tenant filter as the feed: a heading whose number came from a wider
    // query than the list under it is worse than no number at all.
    const args = (
      tx.progressPhoto.groupBy.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0];
    expect(args.where).toEqual({ unitId: 'unit-1', organizationId: ORG });
  });

  it('refuses the totals for a unit the buyer does not own', async () => {
    const tx = baseTx({
      booking: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    });
    setTx(tx);
    const portal = new CustomerPortalService(prismaStub);
    await expect(portal.stageCounts(actor('CUSTOMER'), 'unit-x')).rejects.toThrow(/not found/i);
    expect(tx.progressPhoto.groupBy).not.toHaveBeenCalled();
  });
});
