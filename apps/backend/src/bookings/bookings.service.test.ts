// Bookings service tests - exercises the pure logic without a real DB
// (legalNextStates is the only piece that doesn't need a DB; the
// DB-touching paths need a live Postgres for the RLS JOIN).
//
// Pattern: instantiate BookingsService with a PrismaService stub
// whose $client has the methods we exercise stubbed per-test.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';

import { BookingsService, legalNextStates } from './bookings.service';

function makeActor(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'mgr-1',
    email: 'mgr@shadhilbuilders.in',
    role: 'MANAGER',
    organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
    ...overrides,
  };
}

function makeService(): {
  service: BookingsService;
  client: {
    $transaction: ReturnType<typeof vi.fn>;
    $executeRawUnsafe: ReturnType<typeof vi.fn>;
    booking: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    lead: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    unit: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    team: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    auditLog: { create: ReturnType<typeof vi.fn> };
  };
} {
  const client = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(client),
    ),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    booking: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    // T-BOOK-LEADSYNC: the service now reads lead.state (the bookable-lead
    // guard) and writes lead.state (the sync), plus booking.findMany to compute
    // the target state.
    lead: { findUnique: vi.fn(), update: vi.fn() },
    unit: { findUnique: vi.fn(), update: vi.fn() },
    // T-TEAM-AUTHORITATIVE (2026-09-13): TeamAccessService.getManagedTeamIds
    // calls findMany (a manager may lead multiple teams), not findFirst.
    team: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'a-1' }) },
  };
  const prismaService = { $client: client } as never;
  const service = new BookingsService(prismaService);
  // T-BOOK-LEADSYNC: syncLeadState reads the lead's bookings to compute the
  // target state. Default to "the booking we just wrote" so every test's sync
  // resolves; individual tests override when they assert the state move.
  client.booking.findMany.mockResolvedValue([{ status: 'HOLD' }]);
  client.lead.update.mockResolvedValue({});
  return { service, client };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// T-BOOK-LEADSYNC: every makeService() call re-seeds these defaults, because
// vi.clearAllMocks() in beforeEach wipes any mockResolvedValue set inside the
// factory. Kept as a helper so the transition/delete suites get a readable
// lead + a resolvable booking list without each test restating them.
function makeServiceWithLeadSync() {
  const made = makeService();
  made.client.booking.findMany.mockResolvedValue([{ status: 'HOLD' }]);
  made.client.lead.findUnique.mockResolvedValue({
    id: 'lead-1',
    state: 'NEGOTIATION',
    organizationId: 'ceid01lpfe1esm8jwsxid41k28',
  });
  made.client.lead.update.mockResolvedValue({});
  return made;
}

// ─── legalNextStates - pure state-machine helper ──────────────────────

describe('legalNextStates - booking state machine', () => {
  it.each([
    ['HOLD', ['TOKEN', 'CANCELLED']],
    ['TOKEN', ['APPROVED', 'REJECTED', 'CANCELLED']],
    ['APPROVED', ['CANCELLED']],
    ['REJECTED', []],
    ['CANCELLED', []],
  ] as const)('%s → %s', (from, expected) => {
    expect(legalNextStates(from)).toEqual(expected);
  });

  it('terminal states have no next states', () => {
    expect(legalNextStates('REJECTED')).toEqual([]);
    expect(legalNextStates('CANCELLED')).toEqual([]);
  });
});

// ─── findOne - single booking (approval page) ─────────────────────────

describe('findOne - single booking', () => {
  it('returns the booking row when it exists', async () => {
    const { service, client } = makeService();
    client.booking.findUnique.mockResolvedValue({
      id: 'b-1',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: { toString: () => '100000.00' },
      status: 'TOKEN',
      approvedById: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });

    const result = await service.findOne(makeActor(), 'b-1');
    expect(result.id).toBe('b-1');
    expect(result.leadName).toBe('Lead 1');
    expect(result.userName).toBe('TC 1');
    expect(result.amount).toBe('5000000.00');
    expect(result.status).toBe('TOKEN');
  });

  it('returns 404 when the booking does not exist', async () => {
    const { service, client } = makeService();
    client.booking.findUnique.mockResolvedValue(null);
    await expect(service.findOne(makeActor(), 'missing')).rejects.toThrow(
      /Booking missing not found/,
    );
  });
});

// ─── create - happy path + 404s ──────────────────────────────────────

describe('create - start a new booking in HOLD state', () => {
  it('creates the booking with status=HOLD and writes an audit row', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'NEGOTIATION',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
    client.unit.findUnique.mockResolvedValue({
      id: 'unit-1',
      unitNumber: 'A-101',
      status: 'AVAILABLE',
      // T-BOOKING-AMOUNT-FROM-UNIT (2026-09-16): the server derives the booking
      // amount from this price, so the fixture must provide one.
      price: { toString: () => '5000000.00' },
    });
    client.booking.create.mockResolvedValue({
      id: 'b-1',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'mgr-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      status: 'HOLD',
      approvedById: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'Mgr 1' },
      approvedBy: null,
    });

    const result = await service.create(makeActor(), {
      leadId: 'lead-1',
      unitId: 'unit-1',
      amount: 5_000_000,
    });

    expect(result.status).toBe('HOLD');
    expect(result.amount).toBe('5000000.00');
    // T-BOOK-UNIT: the bookings grid renders the villa number, so the wire
    // shape must carry it (denormalized from the unit relation).
    expect(result.unitNumber).toBe('A-101');
    expect(client.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'HOLD',
          userId: 'mgr-1',
        }),
        select: expect.objectContaining({
          unit: { select: { unitNumber: true } },
        }),
      }),
    );
    // T-INV-SYNC: the unit's status is no longer written by the service - the
    // unit_status_sync_booking DB trigger derives it (SECURITY DEFINER, so it
    // works for every role). The old service-level unit.update silently
    // matched zero rows for non-ADMIN actors under RLS, which is what let the
    // inventory grid and the bookings list drift apart.
    expect(client.unit.update).not.toHaveBeenCalled();
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'booking.create',
          entityType: 'Booking',
        }),
      }),
    );
  });

  it('returns 404 when the lead does not exist', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue(null);
    await expect(
      service.create(makeActor(), {
        leadId: 'missing',
        unitId: 'unit-1',
        amount: 5_000_000,
      }),
    ).rejects.toThrow(/Lead missing not found/);
    expect(client.booking.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the unit does not exist', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'NEGOTIATION',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
    client.unit.findUnique.mockResolvedValue(null);
    await expect(
      service.create(makeActor(), {
        leadId: 'lead-1',
        unitId: 'missing',
        amount: 5_000_000,
      }),
    ).rejects.toThrow(/Unit missing not found/);
    expect(client.booking.create).not.toHaveBeenCalled();
  });

  // ── T-INV-SYNC: a unit takes at most ONE active booking ────────────────
  // The partial unique index one_active_booking_per_unit is the hard
  // guarantee; these cover the readable 409s in front of it.

  it('409s when the unit is already held by another booking', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'NEGOTIATION',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
    client.unit.findUnique.mockResolvedValue({
      id: 'unit-1',
      unitNumber: 'A-101',
      status: 'HOLD',
    });

    await expect(
      service.create(makeActor(), { leadId: 'lead-1', unitId: 'unit-1', amount: 5_000_000 }),
    ).rejects.toThrow(/cannot take a new booking/);
    expect(client.booking.create).not.toHaveBeenCalled();
  });

  it('409s when the unit is SOLD', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'NEGOTIATION',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
    client.unit.findUnique.mockResolvedValue({
      id: 'unit-1',
      unitNumber: 'A-101',
      status: 'SOLD',
    });

    await expect(
      service.create(makeActor(), { leadId: 'lead-1', unitId: 'unit-1', amount: 5_000_000 }),
    ).rejects.toThrow(/cannot take a new booking/);
    expect(client.booking.create).not.toHaveBeenCalled();
  });

  it('rejects TELECALLER - cannot initiate a booking (T-BOOK-ROLES)', async () => {
    const { service, client } = makeService();
    await expect(
      service.create(makeActor({ role: 'TELECALLER', sub: 'tc-1' }), {
        leadId: 'lead-1',
        unitId: 'unit-1',
        amount: 5_000_000,
      }),
    ).rejects.toThrow(/can create a booking/);
    expect(client.booking.create).not.toHaveBeenCalled();
  });

  // ── T-BOOK-LEADSYNC: the lead must be negotiable, and it must stay in step
  // ── with the booking.
  it('409s when the lead is still NEW (booking would skip the sales process)', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'NEW',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });

    await expect(
      service.create(makeActor(), { leadId: 'lead-1', unitId: 'unit-1', amount: 5_000_000 }),
    ).rejects.toThrow(/can only start from/);
    expect(client.booking.create).not.toHaveBeenCalled();
  });

  it('409s when the lead is LOST (reviving is a deliberate act)', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'LOST',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });

    await expect(
      service.create(makeActor(), { leadId: 'lead-1', unitId: 'unit-1', amount: 5_000_000 }),
    ).rejects.toThrow(/can only start from/);
    expect(client.booking.create).not.toHaveBeenCalled();
  });

  // ── T-BOOKING-AMOUNT-FROM-UNIT (2026-09-16, owner ruling) ─────────────────
  // "the price is the price": the booking total comes from the selected unit, and
  // the SERVER is the authority. Before this, `dto.amount` was written straight
  // through, so the client decided the figure - and every existing booking in the
  // database disagreed with its unit.
  it('derives the amount from the unit price, ignoring what the client sent', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'NEGOTIATION',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
    client.unit.findUnique.mockResolvedValue({
      id: 'unit-1',
      unitNumber: 'A-101',
      status: 'AVAILABLE',
      price: { toString: () => '4250000.00' },
    });
    client.booking.create.mockResolvedValue({
      id: 'b-1',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'mgr-1',
      amount: { toString: () => '4250000.00' },
      tokenAmount: null,
      status: 'HOLD',
      approvedById: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'Mgr 1' },
      approvedBy: null,
    });

    await service.create(makeActor(), { leadId: 'lead-1', unitId: 'unit-1', amount: 4250000 });

    // The write carries the UNIT price, formatted as a Decimal string.
    expect(client.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amount: '4250000.00' }),
      }),
    );
  });

  it('REJECTS an amount that disagrees with the unit price', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'NEGOTIATION',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
    client.unit.findUnique.mockResolvedValue({
      id: 'unit-1',
      unitNumber: 'A-101',
      status: 'AVAILABLE',
      price: { toString: () => '4250000.00' },
    });

    // Loudly, not silently corrected: overwriting a bad amount would hide the UI
    // bug, and the entire point is that the two can no longer disagree unnoticed.
    await expect(
      service.create(makeActor(), { leadId: 'lead-1', unitId: 'unit-1', amount: 1 }),
    ).rejects.toThrow(/must equal the unit price/);
    expect(client.booking.create).not.toHaveBeenCalled();
  });

  it('allows a sub-rupee rounding difference but not a real one', async () => {
    const { service, client } = makeService();
    const setup = () => {
      client.lead.findUnique.mockResolvedValue({
        id: 'lead-1',
        state: 'NEGOTIATION',
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',
      });
      client.unit.findUnique.mockResolvedValue({
        id: 'unit-1',
        unitNumber: 'A-101',
        status: 'AVAILABLE',
        price: { toString: () => '4250000.00' },
      });
      client.booking.create.mockResolvedValue({
        id: 'b-1',
        leadId: 'lead-1',
        unitId: 'unit-1',
        userId: 'mgr-1',
        amount: { toString: () => '4250000.00' },
        tokenAmount: null,
        status: 'HOLD',
        approvedById: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        lead: { name: 'Lead 1' },
        unit: { unitNumber: 'A-101' },
        user: { name: 'Mgr 1' },
        approvedBy: null,
      });
    };

    // 0.4 off: tolerated (wire rounding), still writes the UNIT price.
    setup();
    await service.create(makeActor(), {
      leadId: 'lead-1',
      unitId: 'unit-1',
      amount: 4250000.4,
    });
    expect(client.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: '4250000.00' }) }),
    );

    // 2 off: a real disagreement, rejected.
    setup();
    await expect(
      service.create(makeActor(), { leadId: 'lead-1', unitId: 'unit-1', amount: 4250002 }),
    ).rejects.toThrow(/must equal the unit price/);
  });

  it('refuses to book a unit that has no usable price', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'NEGOTIATION',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
    client.unit.findUnique.mockResolvedValue({
      id: 'unit-1',
      unitNumber: 'A-101',
      status: 'AVAILABLE',
      price: { toString: () => '0' },
    });

    // A zero/priceless unit cannot produce an amount, and booking it at 0 would
    // be worse than failing: the figure would look deliberate.
    await expect(
      service.create(makeActor(), { leadId: 'lead-1', unitId: 'unit-1', amount: 0 }),
    ).rejects.toThrow(/no usable price/);
    expect(client.booking.create).not.toHaveBeenCalled();
  });

  it('409s when the unique index fires (concurrent create won the race)', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'NEGOTIATION',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
    client.unit.findUnique.mockResolvedValue({
      id: 'unit-1',
      unitNumber: 'A-101',
      status: 'AVAILABLE',
      // T-BOOKING-AMOUNT-FROM-UNIT (2026-09-16): the server derives the booking
      // amount from this price, so the fixture must provide one.
      price: { toString: () => '5000000.00' },
    });
    client.booking.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`unitId`)',
        { code: 'P2002', clientVersion: '7.10.0' },
      ),
    );

    await expect(
      service.create(makeActor(), { leadId: 'lead-1', unitId: 'unit-1', amount: 5_000_000 }),
    ).rejects.toThrow(/already has an active booking/);
  });
});

// ─── transition - state machine + audit row ──────────────────────────

describe('transition - advance booking state', () => {
  it('HOLD → TOKEN: succeeds, audit row written, no approvedBy change', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue({
      id: 'b-1',
      status: 'HOLD',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });
    client.booking.update.mockResolvedValue({
      id: 'b-1',
      status: 'TOKEN',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });

    // T-BOOK-ROLES: SALES_EXEC initiates a booking (DESIGN.md §4 ✅).
    // This test previously used TELECALLER, which was asserting the missing
    // role gate rather than the intended behaviour.
    const result = await service.transition(
      makeActor({ role: 'SALES_EXEC', sub: 'se-1' }),
      'b-1',
      { toStatus: 'TOKEN' },
    );
    expect(result.status).toBe('TOKEN');
    expect(client.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'TOKEN' },
      }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'booking.transition',
          before: { status: 'HOLD' },
          after: { status: 'TOKEN', approvedById: null },
        }),
      }),
    );
  });

  it('TOKEN → APPROVED: only ADMIN/OWNER, sets approvedById', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue({
      id: 'b-1',
      status: 'TOKEN',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: { toString: () => '100000.00' },
      approvedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });
    client.booking.update.mockResolvedValue({
      id: 'b-1',
      status: 'APPROVED',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: { toString: () => '100000.00' },
      approvedById: 'admin-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: { name: 'Admin 1' },
    });

    const result = await service.transition(makeActor({ role: 'ADMIN', sub: 'admin-1' }), 'b-1', {
      toStatus: 'APPROVED',
    });
    expect(result.status).toBe('APPROVED');
    expect(result.approvedById).toBe('admin-1');
    expect(client.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ approvedById: 'admin-1' }),
      }),
    );
    // T-INV-SYNC: the unit SOLD transition is applied by the DB trigger.
    expect(client.unit.update).not.toHaveBeenCalled();
  });

  it('TOKEN → APPROVED: rejects TELECALLER (not ADMIN/OWNER)', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue({
      id: 'b-1',
      status: 'TOKEN',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });

    await expect(
      service.transition(
        makeActor({ role: 'TELECALLER', sub: 'tc-1' }),
        'b-1',
        { toStatus: 'APPROVED' },
      ),
    ).rejects.toThrow(/Only ADMIN\/OWNER can approve/);
    expect(client.booking.update).not.toHaveBeenCalled();
  });

  // ── Approval revoked from MANAGER (owner decision, 2026-09-24) ──────────
  // The gate previously allowed MANAGER (DESIGN.md §4 then said ✅ "in team").
  // Approval is now ADMIN/OWNER only, so both outcomes must refuse a manager -
  // APPROVED and REJECTED are the same decision and are gated together.
  it('TOKEN → APPROVED: rejects MANAGER (approval is ADMIN/OWNER only)', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue({
      id: 'b-1',
      status: 'TOKEN',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });

    await expect(
      service.transition(makeActor({ role: 'MANAGER', sub: 'mgr-1' }), 'b-1', {
        toStatus: 'APPROVED',
      }),
    ).rejects.toThrow(/Only ADMIN\/OWNER can approve/);
    expect(client.booking.update).not.toHaveBeenCalled();
  });

  it('TOKEN → REJECTED: rejects MANAGER (the negative outcome is the same decision)', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue({
      id: 'b-1',
      status: 'TOKEN',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });

    await expect(
      service.transition(makeActor({ role: 'MANAGER', sub: 'mgr-1' }), 'b-1', {
        toStatus: 'REJECTED',
        reason: 'unit not available for the quoted price',
      } as never),
    ).rejects.toThrow(/Only ADMIN\/OWNER can approve/);
    expect(client.booking.update).not.toHaveBeenCalled();
  });

  it('HOLD → TOKEN: MANAGER may still initiate (approval revocation must not over-tighten)', async () => {
    // Guards against over-tightening: revoking approval must NOT revoke the
    // initiate step, which the matrix still grants Manager.
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue({
      id: 'b-1',
      status: 'HOLD',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });
    client.booking.update.mockResolvedValue({
      id: 'b-1',
      status: 'TOKEN',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });

    const result = await service.transition(makeActor({ role: 'MANAGER', sub: 'mgr-1' }), 'b-1', {
      toStatus: 'TOKEN',
    });
    expect(result.status).toBe('TOKEN');
  });

  // ── T-BOOK-ROLES (2026-09-15): the two role-gate defects ────────────────
  // Defect 1: OWNER was rejected from approving (literal `!== 'ADMIN'` check)
  // even though DESIGN.md §4 grants Super Admin ✅ and the UI shows OWNER the
  // Approve button. The gate now uses the shared isAdminClass() helper.
  // Defect 2: HOLD → TOKEN (and booking create) had NO role gate, so a
  // TELECALLER who owned the lead could initiate a booking - matrix says ❌.

  it('TOKEN → APPROVED: OWNER can approve (isAdminClass, not a literal ADMIN check)', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue({
      id: 'b-1',
      status: 'TOKEN',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });
    client.booking.update.mockResolvedValue({
      id: 'b-1',
      status: 'APPROVED',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: 'owner-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: { name: 'Owner 1' },
    });

    const result = await service.transition(
      makeActor({ role: 'OWNER', sub: 'owner-1' }),
      'b-1',
      { toStatus: 'APPROVED' },
    );

    expect(result.status).toBe('APPROVED');
    expect(result.approvedById).toBe('owner-1');
  });

  it('rejects REJECTED from a plain TELECALLER (approval is MANAGER/ADMIN/OWNER)', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue({
      id: 'b-1',
      status: 'TOKEN',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });

    await expect(
      service.transition(
        makeActor({ role: 'TELECALLER', sub: 'tc-1' }),
        'b-1',
        { toStatus: 'REJECTED', reason: 'not interested' },
      ),
    ).rejects.toThrow(/can approve or reject/);
    expect(client.booking.update).not.toHaveBeenCalled();
  });

  it('HOLD → TOKEN: rejects TELECALLER (cannot initiate a booking)', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue({
      id: 'b-1',
      status: 'HOLD',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });

    await expect(
      service.transition(
        makeActor({ role: 'TELECALLER', sub: 'tc-1' }),
        'b-1',
        { toStatus: 'TOKEN' },
      ),
    ).rejects.toThrow(/can start a booking/);
    expect(client.booking.update).not.toHaveBeenCalled();
  });

  it('rejects illegal transition (HOLD → APPROVED not allowed)', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue({
      id: 'b-1',
      status: 'HOLD',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });
    await expect(
      service.transition(makeActor(), 'b-1', { toStatus: 'APPROVED' }),
    ).rejects.toThrow(/Cannot transition/);
    expect(client.booking.update).not.toHaveBeenCalled();
  });

  it('rejects transition from a terminal state', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue({
      id: 'b-1',
      status: 'CANCELLED',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    });
    await expect(
      service.transition(makeActor(), 'b-1', { toStatus: 'TOKEN' }),
    ).rejects.toThrow(/terminal/);
  });

  it('returns 404 when the booking does not exist', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue(null);
    await expect(
      service.transition(makeActor(), 'missing', { toStatus: 'TOKEN' }),
    ).rejects.toThrow(/Booking missing not found/);
  });
});

// ─── list - role scoping + status filter ──────────────────────────────

describe('list - role-scoped query with status filter', () => {
  it('passes status filter through to the where clause', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.team.findMany.mockResolvedValue([{ id: 'team-mgr' }]);
    client.booking.findMany.mockResolvedValue([]);
    client.booking.count.mockResolvedValue(0);
    await service.list(makeActor(), {
      status: 'HOLD',
      limit: 10,
      offset: 0,
    });
    expect(client.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'HOLD' }),
      }),
    );
  });

  it('MANAGER narrows by every team they lead', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.team.findMany.mockResolvedValue([{ id: 'team-mgr' }]);
    client.booking.findMany.mockResolvedValue([]);
    client.booking.count.mockResolvedValue(0);
    await service.list(makeActor(), { limit: 50, offset: 0 });
    expect(client.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lead: { teamId: { in: ['team-mgr'] } },
        }),
      }),
    );
  });

  it('MANAGER leading multiple teams narrows by ALL of them', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.team.findMany.mockResolvedValue([{ id: 'team-mgr' }, { id: 'team-mgr-2' }]);
    client.booking.findMany.mockResolvedValue([]);
    client.booking.count.mockResolvedValue(0);
    await service.list(makeActor(), { limit: 50, offset: 0 });
    expect(client.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lead: { teamId: { in: ['team-mgr', 'team-mgr-2'] } },
        }),
      }),
    );
  });

  it('TELECALLER narrows by own userId via parent Lead.ownerId', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findMany.mockResolvedValue([]);
    client.booking.count.mockResolvedValue(0);
    await service.list(makeActor({ role: 'TELECALLER', sub: 'tc-1' }), {
      limit: 50,
      offset: 0,
    });
    expect(client.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lead: { ownerId: 'tc-1' },
        }),
      }),
    );
  });

  it('passes search through to the parent Lead name/phone filter', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findMany.mockResolvedValue([]);
    client.booking.count.mockResolvedValue(0);
    await service.list(makeActor(), {
      search: 'priya',
      limit: 10,
      offset: 0,
    });
    expect(client.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lead: expect.objectContaining({
            OR: [
              { name: { contains: 'priya', mode: 'insensitive' } },
              { phone: { contains: 'priya' } },
            ],
          }),
        }),
      }),
    );
  });

  it('merges search with staff role scoping (TELECALLER)', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findMany.mockResolvedValue([]);
    client.booking.count.mockResolvedValue(0);
    await service.list(makeActor({ role: 'TELECALLER', sub: 'tc-1' }), {
      search: 'priya',
      limit: 10,
      offset: 0,
    });
    expect(client.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lead: expect.objectContaining({
            ownerId: 'tc-1',
            OR: [
              { name: { contains: 'priya', mode: 'insensitive' } },
              { phone: { contains: 'priya' } },
            ],
          }),
        }),
      }),
    );
  });
});

// ─── update - edit editable fields + audit row ────────────────────────

describe('update - edit booking fields', () => {
  function bookingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'b-1',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: { toString: () => '100000.00' },
      status: 'HOLD',
      approvedById: null,
      notes: 'old note',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
      ...overrides,
    };
  }

  it('updates amount/tokenAmount/notes and writes an audit row', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue(bookingRow());
    client.booking.update.mockResolvedValue(
      bookingRow({
        amount: { toString: () => '6000000.00' },
        tokenAmount: { toString: () => '200000.00' },
        notes: 'new note',
      }),
    );

    const result = await service.update(makeActor(), 'b-1', {
      amount: 6_000_000,
      tokenAmount: 200_000,
      notes: 'new note',
    });

    expect(result.amount).toBe('6000000.00');
    expect(result.tokenAmount).toBe('200000.00');
    expect(result.notes).toBe('new note');
    expect(client.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'b-1' },
        data: expect.objectContaining({
          amount: '6000000.00',
          tokenAmount: '200000.00',
          notes: 'new note',
        }),
      }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'booking.update',
          entityType: 'Booking',
          before: expect.objectContaining({ amount: '5000000.00' }),
          after: expect.objectContaining({ amount: '6000000.00' }),
        }),
      }),
    );
  });

  it('clears tokenAmount when null is passed', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue(bookingRow());
    client.booking.update.mockResolvedValue(
      bookingRow({ tokenAmount: null, notes: 'old note' }),
    );

    await service.update(makeActor(), 'b-1', { tokenAmount: null });

    expect(client.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tokenAmount: null }),
      }),
    );
  });

  it('returns 404 when the booking does not exist', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue(null);
    await expect(
      service.update(makeActor(), 'missing', { amount: 5_000_000 }),
    ).rejects.toThrow(/Booking missing not found/);
    expect(client.booking.update).not.toHaveBeenCalled();
  });
});

// ─── delete - admin-only + unit free + audit row ─────────────────────

describe('delete - remove a booking (ADMIN/OWNER only)', () => {
  function bookingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'b-1',
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      status: 'HOLD',
      approvedById: null,
      notes: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
      ...overrides,
    };
  }

  it('deletes the booking (unit recompute is the trigger\'s job)', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue(bookingRow());
    client.booking.delete.mockResolvedValue({ id: 'b-1' });

    const result = await service.delete(makeActor({ role: 'ADMIN' }), 'b-1');

    expect(result).toEqual({ id: 'b-1' });
    expect(client.booking.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b-1' } }),
    );
    // T-INV-SYNC: freeing the unit moved to the AFTER DELETE trigger.
    expect(client.unit.update).not.toHaveBeenCalled();
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'booking.delete',
          entityType: 'Booking',
        }),
      }),
    );
  });

  it('does not touch the unit itself - the trigger owns that write', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue(bookingRow());
    client.booking.delete.mockResolvedValue({ id: 'b-1' });

    await service.delete(makeActor({ role: 'ADMIN' }), 'b-1');

    expect(client.unit.update).not.toHaveBeenCalled();
    expect(client.booking.count).not.toHaveBeenCalled();
  });

  it('rejects TELECALLER (not ADMIN/OWNER)', async () => {
    const { service, client } = makeServiceWithLeadSync();
    await expect(
      service.delete(makeActor({ role: 'TELECALLER', sub: 'tc-1' }), 'b-1'),
    ).rejects.toThrow(/Only ADMIN\/OWNER/);
    expect(client.booking.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when the booking does not exist', async () => {
    const { service, client } = makeServiceWithLeadSync();
    client.booking.findUnique.mockResolvedValue(null);
    await expect(
      service.delete(makeActor({ role: 'ADMIN' }), 'missing'),
    ).rejects.toThrow(/Booking missing not found/);
    expect(client.booking.delete).not.toHaveBeenCalled();
  });
});

// ─── T-BOOK-LEADSYNC: the lead follows its bookings ─────────────────────────
//
// The sync runs inside the same transaction as the booking write, so these
// assert on `lead.update` (the observable side effect). Direction guard: an
// ordinary progression is forward-only, a cancel/reject is an explicit release.

describe('T-BOOK-LEADSYNC - lead.state follows the booking', () => {
  function transitioningRow(from: string) {
    return {
      id: 'b-1',
      status: from,
      leadId: 'lead-1',
      unitId: 'unit-1',
      userId: 'tc-1',
      amount: { toString: () => '5000000.00' },
      tokenAmount: null,
      approvedById: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: null,
    };
  }

  function syncService() {
    const made = makeService();
    made.client.auditLog.create.mockResolvedValue({ id: 'a-1' });
    return made;
  }

  it('APPROVED advances the lead to WON', async () => {
    const { service, client } = syncService();
    client.booking.findUnique.mockResolvedValue(transitioningRow('TOKEN'));
    client.booking.update.mockResolvedValue(transitioningRow('APPROVED'));
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'BOOKING_INITIATED',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
    client.booking.findMany.mockResolvedValue([{ status: 'APPROVED' }]);

    // Approval is ADMIN/OWNER only (2026-09-24); makeActor() defaults to
    // MANAGER, so this lead-sync assertion must use an admin actor. The test's
    // subject is the lead.state sync, not the role gate.
    await service.transition(makeActor({ role: 'ADMIN', sub: 'admin-1' }), 'b-1', {
      toStatus: 'APPROVED',
    });

    expect(client.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'lead-1' }, data: { state: 'WON' } }),
    );
  });

  it('TOKEN advances the lead to BOOKING_INITIATED', async () => {
    const { service, client } = syncService();
    client.booking.findUnique.mockResolvedValue(transitioningRow('HOLD'));
    client.booking.update.mockResolvedValue(transitioningRow('TOKEN'));
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'NEGOTIATION',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
    client.booking.findMany.mockResolvedValue([{ status: 'TOKEN' }]);

    await service.transition(makeActor({ role: 'SALES_EXEC', sub: 'se-1' }), 'b-1', {
      toStatus: 'TOKEN',
    });

    expect(client.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { state: 'BOOKING_INITIATED' } }),
    );
  });

  it('CANCELLED releases the lead back to NEGOTIATION even from WON', async () => {
    const { service, client } = syncService();
    client.booking.findUnique.mockResolvedValue(transitioningRow('APPROVED'));
    client.booking.update.mockResolvedValue(transitioningRow('CANCELLED'));
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'WON',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
    client.booking.findMany.mockResolvedValue([{ status: 'CANCELLED' }]);

    await service.transition(makeActor({ role: 'ADMIN', sub: 'a-1' }), 'b-1', {
      toStatus: 'CANCELLED',
      reason: 'customer backed out',
    });

    expect(client.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { state: 'NEGOTIATION' } }),
    );
  });

  it('a stale extra HOLD cannot regress a WON lead on an ordinary transition', async () => {
    const { service, client } = syncService();
    client.booking.findUnique.mockResolvedValue(transitioningRow('TOKEN'));
    client.booking.update.mockResolvedValue(transitioningRow('APPROVED'));
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'WON',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
    // Target is WON (approved booking wins) and the lead is already WON - the
    // sync must be a complete no-op, not a write.
    client.booking.findMany.mockResolvedValue([{ status: 'APPROVED' }, { status: 'CANCELLED' }]);

    await service.transition(makeActor({ role: 'ADMIN', sub: 'admin-1' }), 'b-1', {
      toStatus: 'APPROVED',
    });

    expect(client.lead.update).not.toHaveBeenCalled();
  });

  it('deleting the last booking re-syncs the lead to NEGOTIATION', async () => {
    const { service, client } = syncService();
    client.booking.findUnique.mockResolvedValue(transitioningRow('HOLD'));
    client.booking.delete.mockResolvedValue({ id: 'b-1' });
    client.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      state: 'WON',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
    client.booking.findMany.mockResolvedValue([]);

    await service.delete(makeActor({ role: 'ADMIN' }), 'b-1');

    expect(client.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { state: 'NEGOTIATION' } }),
    );
  });
});

// T-BOOK-REASON: a CANCELLED/REJECTED transition must carry an operator-supplied
// reason. The DTO's comment always claimed this, but `reason` was merely
// `.optional()` and the service never checked - verified live: a cancel with NO
// reason (and one with only whitespace) both succeeded and the audit row stored
// the generated "Booking HOLD -> CANCELLED by <email>" placeholder instead of a
// real justification.
describe('transition - a reason is required for CANCELLED/REJECTED', () => {
  function makeCancelService(from: 'HOLD' | 'TOKEN') {
    // makeServiceWithLeadSync() already seeds booking.findMany + the lead read
    // that syncLeadState needs; a bare makeService() leaves lead.findUnique
    // resolving undefined and the sync throws before the assertion.
    const made = makeServiceWithLeadSync();
    made.client.booking.findUnique.mockResolvedValue({
      id: 'bk1',
      status: from,
      leadId: 'ld1',
      unitId: 'un1',
      userId: 'u-1',
      amount: '1000.00',
      tokenAmount: null,
      approvedById: null,
      notes: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: { name: 'Manager' },
    });
    made.client.booking.update.mockResolvedValue({
      id: 'bk1',
      status: 'CANCELLED',
      leadId: 'ld1',
      unitId: 'un1',
      userId: 'u-1',
      amount: '1000.00',
      tokenAmount: null,
      approvedById: null,
      notes: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      lead: { name: 'Lead 1' },
      unit: { unitNumber: 'A-101' },
      user: { name: 'TC 1' },
      approvedBy: { name: 'Manager' },
    });
    made.client.auditLog.create.mockResolvedValue({ id: 'a-1' });
    return made;
  }

  it('rejects CANCELLED with no reason at all', async () => {
    const { service, client } = makeCancelService('HOLD');
    await expect(
      service.transition(makeActor({ role: 'OWNER' }), 'bk1', { toStatus: 'CANCELLED' } as never),
    ).rejects.toThrow(/reason is required/i);
    // The write must not have happened.
    expect(client.booking.update).not.toHaveBeenCalled();
  });

  it('rejects CANCELLED with a whitespace-only reason', async () => {
    const { service, client } = makeCancelService('HOLD');
    await expect(
      service.transition(makeActor({ role: 'OWNER' }), 'bk1', {
        toStatus: 'CANCELLED',
        reason: '   ',
      } as never),
    ).rejects.toThrow(/reason is required/i);
    expect(client.booking.update).not.toHaveBeenCalled();
  });

  it('rejects REJECTED with no reason', async () => {
    const { service } = makeCancelService('TOKEN');
    // Rejection is an approval decision -> ADMIN/OWNER (2026-09-24). The
    // subject here is the reason requirement, which is checked AFTER the role
    // gate, so the actor must clear the gate for the reason rule to be reached.
    await expect(
      service.transition(makeActor({ role: 'ADMIN' }), 'bk1', { toStatus: 'REJECTED' } as never),
    ).rejects.toThrow(/reason is required/i);
  });

  it('accepts CANCELLED with a real reason and stores it verbatim in the audit', async () => {
    const { service, client } = makeCancelService('HOLD');
    await service.transition(makeActor({ role: 'OWNER' }), 'bk1', {
      toStatus: 'CANCELLED',
      reason: 'customer backed out',
    } as never);
    const auditArg = client.auditLog.create.mock.calls.at(-1)?.[0] as {
      data: { reason: string };
    };
    expect(auditArg.data.reason).toBe('customer backed out');
  });

  it('still allows a forward move with NO reason (HOLD -> TOKEN)', async () => {
    const { service } = makeCancelService('HOLD');
    await expect(
      service.transition(makeActor({ role: 'MANAGER' }), 'bk1', { toStatus: 'TOKEN' } as never),
    ).resolves.toBeDefined();
  });
});
