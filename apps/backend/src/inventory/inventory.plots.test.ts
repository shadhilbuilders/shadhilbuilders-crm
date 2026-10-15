// InventoryService.plots() - CMDA plot availability, joined to the real records
// behind each plot.
//
// Separate file from `inventory.service.test.ts` so the plot contract gets its
// own focused harness. The interesting cases are what the method must REFUSE (a
// villa with no plot number is not on the layout), what it must never do (paint
// a sold plot as available, or read a door number as a plot number), and what it
// must CARRY (the unit row and its live booking, so the map can name the villa
// and its buyer).
//
// Pure unit tests against a stubbed client - no database. `withRlsContext`
// works against the stub because it only needs `$transaction` and
// `$executeRawUnsafe`, both of which the harness provides.

import { PlotStatusRowSchema, type BookingStatus, type UnitStatus } from '@shadhil/api-types';
import type { JwtPayload } from '@shadhil/auth';
import { Prisma } from '@shadhil/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InventoryService, pickClaimBooking, type ClaimBookingSource } from './inventory.service';
import { UNIT_ROW_SELECT, type UnitRowSource } from './unit-row';

function makeActor(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'manager-1',
    email: 'manager@shadhilbuilders.in',
    role: 'MANAGER',
    organizationId: 'org-1',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
    ...overrides,
  };
}

function makeService() {
  const client = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn(client)),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    unit: { findMany: vi.fn().mockResolvedValue([]) },
    booking: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const prismaService = { $client: client } as never;
  return { service: new InventoryService(prismaService), client };
}

/**
 * A unit row exactly as `UNIT_ROW_SELECT` returns it.
 *
 * The first argument is the PLOT number; `null` means nobody has placed the
 * villa on the layout. The door number is derived from the plot number but can
 * be overridden, so a test can set up the case that matters most here: a villa
 * whose DOOR number happens to look like a plot number.
 */
function unit(
  plotNumber: number | null,
  status: UnitStatus,
  overrides: {
    id?: string;
    price?: string;
    bhk?: number;
    unitNumber?: string;
    phaseId?: string;
  } = {},
): UnitRowSource {
  return {
    id: overrides.id ?? `unit-${plotNumber ?? 'unassigned'}`,
    phaseId: overrides.phaseId ?? 'phase-1',
    unitNumber: overrides.unitNumber ?? (plotNumber === null ? 'D-999' : `A-${plotNumber}`),
    plotNumber,
    bhk: overrides.bhk ?? 3,
    facing: 'East',
    sqft: 1450,
    buildupSqft: new Prisma.Decimal('1450.00'),
    pricePerSqft: new Prisma.Decimal('4000.00'),
    price: new Prisma.Decimal(overrides.price ?? '5800000.00'),
    status,
    createdAt: new Date('2026-10-01T09:00:00.000Z'),
    phase: { name: 'CMDA Plots', projectId: 'proj-1', project: { name: 'Demo Villas' } },
  };
}

/** A booking row exactly as the claim query returns it. */
function booking(
  unitId: string,
  status: BookingStatus,
  overrides: { id?: string; leadName?: string; createdAt?: string; amount?: string } = {},
): ClaimBookingSource {
  return {
    id: overrides.id ?? `booking-${unitId}`,
    unitId,
    status,
    amount: new Prisma.Decimal(overrides.amount ?? '5800000.00'),
    tokenAmount: null,
    leadId: 'lead-1',
    createdAt: new Date(overrides.createdAt ?? '2026-10-02T09:00:00.000Z'),
    lead: { name: overrides.leadName ?? 'Demo Vikram' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('plots - the plot number is the only bridge to a plot', () => {
  it('reads a unit by its plot number, and carries the unit behind it', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([unit(37, 'AVAILABLE')]);

    const { rows } = await service.plots(makeActor(), 'proj-1');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.plotNumber).toBe(37);
    expect(rows[0]?.status).toBe('available');
    expect(rows[0]?.units).toHaveLength(1);
    expect(rows[0]?.units[0]?.unit.plotNumber).toBe(37);
    expect(rows[0]?.units[0]?.unit.unitNumber).toBe('A-37');
    expect(rows[0]?.units[0]?.booking).toBeNull();
    // The whole row must satisfy the contract every consumer parses it with.
    expect(() => PlotStatusRowSchema.parse(rows[0])).not.toThrow();
  });

  it('places a villa by its plot number, never by its door number', async () => {
    // The reason the two are separate fields: a villa whose door number reads
    // "37" is not automatically plot 37. Here it sits on plot 5.
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([unit(5, 'AVAILABLE', { unitNumber: '37' })]);

    const { rows } = await service.plots(makeActor(), 'proj-1');
    expect(rows.map((row) => row.plotNumber)).toEqual([5]);
    expect(rows[0]?.units[0]?.unit.unitNumber).toBe('37');
  });

  it('ignores a unit with no plot number, even if it reaches the service', async () => {
    // The SQL filter should exclude these, but the JS side must not trust that:
    // an unassigned villa ("D-101") lives on the inventory grid, not on the
    // layout, and painting it onto some plot would be an invention.
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([
      unit(null, 'SOLD', { unitNumber: 'D-101' }),
      unit(null, 'HOLD', { unitNumber: 'A-12' }),
      unit(null, 'AVAILABLE', { unitNumber: 'Villa 3' }),
    ]);

    await expect(service.plots(makeActor(), 'proj-1')).resolves.toEqual({ rows: [] });
  });

  it('filters in SQL to the plot-numbered units rather than fetching a whole project', async () => {
    const { service, client } = makeService();
    await service.plots(makeActor(), 'proj-1');

    const call = client.unit.findMany.mock.calls[0]?.[0] as {
      where: { plotNumber?: { not: null }; phase?: { projectId: string } };
      select: unknown;
    };
    expect(call.where.plotNumber).toEqual({ not: null });
    expect(call.where.phase).toEqual({ projectId: 'proj-1' });
    // The unit's own columns, from the one shared select every unit surface uses.
    expect(call.select).toEqual(UNIT_ROW_SELECT);
  });

  it("scopes to the actor's organization, because the RLS policy checks the role only", async () => {
    // Unit's SELECT policy (unit_select_any_authenticated) carries no org term,
    // so `projectId` alone - a query-string value - would let a caller read
    // another tenant's villa numbers, areas and prices.
    const { service, client } = makeService();
    await service.plots(makeActor({ organizationId: 'org-1' }), 'proj-from-another-org');

    const call = client.unit.findMany.mock.calls[0]?.[0] as {
      where: { organizationId?: string; phase?: { projectId: string } };
    };
    expect(call.where.organizationId).toBe('org-1');
    // The project filter NARROWS; it must not replace the org term.
    expect(call.where.phase).toEqual({ projectId: 'proj-from-another-org' });
  });

  it('does not scope by project when no project is given', async () => {
    const { service, client } = makeService();
    await service.plots(makeActor());

    const call = client.unit.findMany.mock.calls[0]?.[0] as {
      where: { phase?: { projectId: string } };
    };
    expect(call.where.phase).toBeUndefined();
  });
});

describe('plots - the records behind the plot', () => {
  it('carries the live booking, with the buyer, on the unit that claims the plot', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([unit(37, 'SOLD')]);
    client.booking.findMany.mockResolvedValue([booking('unit-37', 'APPROVED')]);

    const { rows } = await service.plots(makeActor(), 'proj-1');
    const claim = rows[0]?.units[0];

    expect(claim?.booking).toEqual({
      id: 'booking-unit-37',
      status: 'APPROVED',
      // Prisma Decimal normalises: 5800000.00 prints as "5800000".
      amount: '5800000',
      tokenAmount: null,
      leadId: 'lead-1',
      leadName: 'Demo Vikram',
      createdAt: '2026-10-02T09:00:00.000Z',
    });
    // The unit's own stored price travels with it, so the panel shows a real
    // figure instead of the "Not set" it used to print for every plot.
    expect(claim?.unit.price).toBe('5800000');
    expect(claim?.unit.phaseName).toBe('CMDA Plots');
  });

  it("asks for every claiming unit's bookings in ONE query, filtered to the live statuses", async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([unit(5, 'SOLD'), unit(6, 'AVAILABLE')]);

    await service.plots(makeActor(), 'proj-1');

    expect(client.booking.findMany).toHaveBeenCalledTimes(1);
    const call = client.booking.findMany.mock.calls[0]?.[0] as {
      where: { unitId: { in: string[] }; status: { in: string[] } };
    };
    expect(call.where.unitId.in).toEqual(['unit-5', 'unit-6']);
    expect(call.where.status.in).toEqual(['HOLD', 'TOKEN', 'APPROVED']);
  });

  it('skips the booking query entirely when no unit has a plot number', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([]);

    await expect(service.plots(makeActor(), 'proj-1')).resolves.toEqual({ rows: [] });
    expect(client.booking.findMany).not.toHaveBeenCalled();
  });

  it('keeps the unit and reports no booking when the booking is hidden from the caller', async () => {
    // A SOLD unit whose booking RLS hides (a TELECALLER looking at a teammate's
    // deal) must still render the villa. The panel is responsible for wording
    // this as "not visible to you" rather than "no booking".
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([unit(37, 'SOLD')]);
    client.booking.findMany.mockResolvedValue([]);

    const { rows } = await service.plots(makeActor({ role: 'TELECALLER' }), 'proj-1');
    expect(rows[0]?.status).toBe('booked');
    expect(rows[0]?.units[0]?.unit.plotNumber).toBe(37);
    expect(rows[0]?.units[0]?.booking).toBeNull();
  });
});

describe('plots - conflicts and ordering', () => {
  it('lets the most binding claim win and leads the row with it', async () => {
    // A phase holds a plot number once, but two phases of one project can each
    // hold plot 37. A sold plot must never read available, and the sold unit
    // must be the one the panel shows first.
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([
      unit(37, 'AVAILABLE', { id: 'unit-37-free', phaseId: 'phase-b' }),
      unit(37, 'SOLD', { id: 'unit-37-sold', phaseId: 'phase-a' }),
      unit(40, 'AVAILABLE'),
      unit(40, 'HOLD', { phaseId: 'phase-b' }),
      unit(41, 'AVAILABLE'),
    ]);

    const { rows } = await service.plots(makeActor(), 'proj-1');
    expect(rows.map((row) => [row.plotNumber, row.status])).toEqual([
      [37, 'booked'],
      [40, 'blocked'],
      [41, 'available'],
    ]);

    const conflict = rows[0];
    expect(conflict?.units).toHaveLength(2);
    expect(conflict?.units[0]?.unit.id).toBe('unit-37-sold');
    expect(conflict?.units[1]?.unit.id).toBe('unit-37-free');
  });

  it('returns rows sorted by plot number', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([
      unit(99, 'AVAILABLE'),
      unit(7, 'AVAILABLE'),
      unit(42, 'AVAILABLE'),
    ]);

    const { rows } = await service.plots(makeActor(), 'proj-1');
    expect(rows.map((row) => row.plotNumber)).toEqual([7, 42, 99]);
  });

  it('returns an empty row set when nothing has a plot number', async () => {
    // The state of a project whose villas are entered by door number only. This
    // is a normal answer, not an error - the map then reads all available.
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([]);
    await expect(service.plots(makeActor(), 'proj-1')).resolves.toEqual({ rows: [] });
  });

  it('emits every row through the shared schema without loss', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue(
      (['AVAILABLE', 'HOLD', 'TOKEN', 'SOLD'] as const).map((status, index) =>
        unit(index + 1, status),
      ),
    );

    const { rows } = await service.plots(makeActor(), 'proj-1');
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(() => PlotStatusRowSchema.parse(row)).not.toThrow();
    }
  });
});

describe('plots - unknown unit status fails loudly', () => {
  it('throws rather than painting an unrecognised status as available', async () => {
    // A status the shared contract does not know means the database and the
    // generated client have drifted. Guessing a colour would be worse than a
    // 500, because every surface would then be silently wrong.
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([unit(37, 'RESERVED_BY_ALIENS' as UnitStatus)]);

    await expect(service.plots(makeActor(), 'proj-1')).rejects.toThrow(/not a known UnitStatus/);
  });
});

describe('pickClaimBooking', () => {
  it('returns null when nothing holds the unit', () => {
    expect(pickClaimBooking([])).toBeNull();
  });

  it('prefers the approved booking over a newer hold', () => {
    const picked = pickClaimBooking([
      booking('unit-37', 'HOLD', { id: 'newer-hold', createdAt: '2026-10-09T09:00:00.000Z' }),
      booking('unit-37', 'APPROVED', { id: 'approved', createdAt: '2026-10-02T09:00:00.000Z' }),
    ]);
    expect(picked?.id).toBe('approved');
    expect(picked?.status).toBe('APPROVED');
  });

  it('never presents a terminal booking as the claim on the unit', () => {
    // A cancelled or rejected deal releases the villa; showing it as the reason
    // the plot is gone would invent a buyer.
    expect(pickClaimBooking([booking('unit-37', 'CANCELLED')])).toBeNull();
    expect(pickClaimBooking([booking('unit-37', 'REJECTED')])).toBeNull();
    expect(
      pickClaimBooking([booking('unit-37', 'CANCELLED'), booking('unit-37', 'HOLD')])?.status,
    ).toBe('HOLD');
  });

  it('serialises the Decimal amounts and the date for the wire', () => {
    const picked = pickClaimBooking([
      {
        ...booking('unit-37', 'TOKEN', { amount: '5800000.00' }),
        tokenAmount: new Prisma.Decimal('250000.00'),
      },
    ]);
    expect(picked?.amount).toBe('5800000');
    expect(picked?.tokenAmount).toBe('250000');
    expect(picked?.createdAt).toBe('2026-10-02T09:00:00.000Z');
  });
});
