// Bookings service tests - exercises the pure logic without a real DB
// (legalNextStates is the only piece that doesn't need a DB; the
// DB-touching paths need a live Postgres for the RLS JOIN).
//
// Pattern: instantiate BookingsService with a PrismaService stub
// whose $client has the methods we exercise stubbed per-test.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';

import { BookingsService, legalNextStates } from './bookings.service';

function makeActor(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'mgr-1',
    email: 'mgr@shadhilbuilders.in',
    role: 'MANAGER',
    teamId: 'team-mgr',
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
    };
    lead: { findUnique: ReturnType<typeof vi.fn> };
    unit: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    team: { findFirst: ReturnType<typeof vi.fn> };
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
    },
    lead: { findUnique: vi.fn() },
    unit: { findUnique: vi.fn(), update: vi.fn() },
    team: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'a-1' }) },
  };
  const prismaService = { $client: client } as never;
  const service = new BookingsService(prismaService);
  return { service, client };
}

beforeEach(() => {
  vi.clearAllMocks();
});

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
    client.lead.findUnique.mockResolvedValue({ id: 'lead-1' });
    client.unit.findUnique.mockResolvedValue({ id: 'unit-1' });
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
    expect(client.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'HOLD',
          userId: 'mgr-1',
        }),
      }),
    );
    // T-INV-SYNC: creating a booking holds the unit.
    expect(client.unit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'unit-1' },
        data: { status: 'HOLD' },
      }),
    );
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
        amount: 1,
      }),
    ).rejects.toThrow(/Lead missing not found/);
    expect(client.booking.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the unit does not exist', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({ id: 'lead-1' });
    client.unit.findUnique.mockResolvedValue(null);
    await expect(
      service.create(makeActor(), {
        leadId: 'lead-1',
        unitId: 'missing',
        amount: 1,
      }),
    ).rejects.toThrow(/Unit missing not found/);
    expect(client.booking.create).not.toHaveBeenCalled();
  });
});

// ─── transition - state machine + audit row ──────────────────────────

describe('transition - advance booking state', () => {
  it('HOLD → TOKEN: succeeds, audit row written, no approvedBy change', async () => {
    const { service, client } = makeService();
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
      user: { name: 'TC 1' },
      approvedBy: null,
    });

    const result = await service.transition(
      makeActor({ role: 'TELECALLER' }),
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

  it('TOKEN → APPROVED: only MANAGER/ADMIN, sets approvedById', async () => {
    const { service, client } = makeService();
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
      approvedById: 'mgr-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      lead: { name: 'Lead 1' },
      user: { name: 'TC 1' },
      approvedBy: { name: 'Mgr 1' },
    });

    const result = await service.transition(makeActor(), 'b-1', {
      toStatus: 'APPROVED',
    });
    expect(result.status).toBe('APPROVED');
    expect(result.approvedById).toBe('mgr-1');
    expect(client.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ approvedById: 'mgr-1' }),
      }),
    );
    // T-INV-SYNC: approving a booking marks the unit SOLD.
    expect(client.unit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'unit-1' },
        data: { status: 'SOLD' },
      }),
    );
  });

  it('TOKEN → APPROVED: rejects TELECALLER (not MANAGER/ADMIN)', async () => {
    const { service, client } = makeService();
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
      user: { name: 'TC 1' },
      approvedBy: null,
    });

    await expect(
      service.transition(
        makeActor({ role: 'TELECALLER', sub: 'tc-1' }),
        'b-1',
        { toStatus: 'APPROVED' },
      ),
    ).rejects.toThrow(/Only MANAGER\/ADMIN/);
    expect(client.booking.update).not.toHaveBeenCalled();
  });

  it('rejects illegal transition (HOLD → APPROVED not allowed)', async () => {
    const { service, client } = makeService();
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
      user: { name: 'TC 1' },
      approvedBy: null,
    });
    await expect(
      service.transition(makeActor(), 'b-1', { toStatus: 'APPROVED' }),
    ).rejects.toThrow(/Cannot transition/);
    expect(client.booking.update).not.toHaveBeenCalled();
  });

  it('rejects transition from a terminal state', async () => {
    const { service, client } = makeService();
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
      user: { name: 'TC 1' },
      approvedBy: null,
    });
    await expect(
      service.transition(makeActor(), 'b-1', { toStatus: 'TOKEN' }),
    ).rejects.toThrow(/terminal/);
  });

  it('returns 404 when the booking does not exist', async () => {
    const { service, client } = makeService();
    client.booking.findUnique.mockResolvedValue(null);
    await expect(
      service.transition(makeActor(), 'missing', { toStatus: 'TOKEN' }),
    ).rejects.toThrow(/Booking missing not found/);
  });
});

// ─── list - role scoping + status filter ──────────────────────────────

describe('list - role-scoped query with status filter', () => {
  it('passes status filter through to the where clause', async () => {
    const { service, client } = makeService();
    client.team.findFirst.mockResolvedValue({ id: 'team-mgr' });
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

  it('MANAGER narrows by own team', async () => {
    const { service, client } = makeService();
    client.team.findFirst.mockResolvedValue({ id: 'team-mgr' });
    client.booking.findMany.mockResolvedValue([]);
    client.booking.count.mockResolvedValue(0);
    await service.list(makeActor(), { limit: 50, offset: 0 });
    expect(client.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lead: { teamId: 'team-mgr' },
        }),
      }),
    );
  });

  it('TELECALLER narrows by own userId via parent Lead.ownerId', async () => {
    const { service, client } = makeService();
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
});
