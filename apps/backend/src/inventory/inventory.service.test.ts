// Inventory service tests - exercises the pure logic without a real DB.
//
// Pattern: instantiate InventoryService with a PrismaService stub
// whose $client has the methods we exercise stubbed per-test (mirrors
// bookings.service.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';

import { InventoryService } from './inventory.service';

function makeActor(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'admin-1',
    email: 'admin@shadhilbuilders.in',
    role: 'ADMIN',
    teamId: null,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
    ...overrides,
  };
}

function makeService(): {
  service: InventoryService;
  client: {
    $transaction: ReturnType<typeof vi.fn>;
    $executeRawUnsafe: ReturnType<typeof vi.fn>;
    unit: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    phase: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
    booking: { count: ReturnType<typeof vi.fn> };
    auditLog: { create: ReturnType<typeof vi.fn> };
  };
} {
  const client = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(client),
    ),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    unit: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    phase: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    booking: { count: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'a-1' }) },
  };
  const prismaService = { $client: client } as never;
  const service = new InventoryService(prismaService);
  return { service, client };
}

function unitRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'unit-1',
    phaseId: 'phase-1',
    unitNumber: 'A-101',
    bhk: 3,
    facing: 'North',
    sqft: 1450,
    price: { toString: () => '5800000.00' },
    status: 'AVAILABLE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    phase: {
      name: 'Phase A',
      projectId: 'proj-1',
      project: { name: 'Metro Heights' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── list - filters + role scoping ────────────────────────────────────

describe('list - role-scoped grid with filters', () => {
  it('passes status array + bhk + facing through to the where clause', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([]);
    client.unit.count.mockResolvedValue(0);
    await service.list(makeActor(), {
      status: ['AVAILABLE', 'HOLD'],
      bhk: 3,
      facing: 'North',
      limit: 10,
      offset: 0,
    });
    expect(client.unit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['AVAILABLE', 'HOLD'] },
          bhk: 3,
          facing: { equals: 'North', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('narrows by projectId via the parent phase', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([]);
    client.unit.count.mockResolvedValue(0);
    await service.list(makeActor(), {
      projectId: 'proj-1',
      limit: 50,
      offset: 0,
    });
    expect(client.unit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ phase: { projectId: 'proj-1' } }),
      }),
    );
  });

  it('maps rows to the UnitRow wire shape', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([unitRow()]);
    client.unit.count.mockResolvedValue(1);
    const result = await service.list(makeActor(), { limit: 50, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.rows[0]).toMatchObject({
      id: 'unit-1',
      phaseName: 'Phase A',
      projectName: 'Metro Heights',
      unitNumber: 'A-101',
      price: '5800000.00',
      status: 'AVAILABLE',
    });
  });
});

// ─── findOne - detail ────────────────────────────────────────────────

describe('findOne - unit detail', () => {
  it('returns the unit with phase + project names', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue(unitRow());
    const result = await service.findOne(makeActor(), 'unit-1');
    expect(result.unitNumber).toBe('A-101');
    expect(result.phaseName).toBe('Phase A');
    expect(result.projectName).toBe('Metro Heights');
  });

  it('returns 404 when the unit does not exist', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue(null);
    await expect(service.findOne(makeActor(), 'missing')).rejects.toThrow(
      /Unit missing not found/,
    );
  });
});

// ─── phases - filter + detail ────────────────────────────────────────

describe('phases - list phases with unit counts', () => {
  it('returns phases with unitCount', async () => {
    const { service, client } = makeService();
    client.phase.findMany.mockResolvedValue([
      { id: 'phase-1', projectId: 'proj-1', name: 'Phase A', _count: { units: 5 } },
    ]);
    const result = await service.phases(makeActor(), 'proj-1');
    expect(result).toEqual([
      { id: 'phase-1', projectId: 'proj-1', name: 'Phase A', unitCount: 5 },
    ]);
    expect(client.phase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: 'proj-1' } }),
    );
  });
});

// ─── create - admin-only + audit row ─────────────────────────────────

describe('create - new unit (ADMIN/OWNER only)', () => {
  it('creates the unit with status=AVAILABLE and writes an audit row', async () => {
    const { service, client } = makeService();
    client.phase.findUnique.mockResolvedValue({
      id: 'phase-1',
      name: 'Phase A',
      projectId: 'proj-1',
      project: { name: 'Metro Heights' },
    });
    client.unit.create.mockResolvedValue({
      id: 'unit-1',
      phaseId: 'phase-1',
      unitNumber: 'A-101',
      bhk: 3,
      facing: 'North',
      sqft: 1450,
      price: { toString: () => '5800000.00' },
      status: 'AVAILABLE',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = await service.create(makeActor(), {
      phaseId: 'phase-1',
      unitNumber: 'A-101',
      bhk: 3,
      facing: 'North',
      sqft: 1450,
      price: 5_800_000,
    });

    expect(result.status).toBe('AVAILABLE');
    expect(result.price).toBe('5800000.00');
    expect(client.unit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'AVAILABLE',
          price: '5800000.00',
        }),
      }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'inventory.unit.create',
          entityType: 'Unit',
        }),
      }),
    );
  });

  it('rejects TELECALLER (not ADMIN/OWNER)', async () => {
    const { service, client } = makeService();
    await expect(
      service.create(makeActor({ role: 'TELECALLER', sub: 'tc-1' }), {
        phaseId: 'phase-1',
        unitNumber: 'A-101',
        bhk: 3,
        price: 1,
      }),
    ).rejects.toThrow(/Only ADMIN\/OWNER/);
    expect(client.unit.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the phase does not exist', async () => {
    const { service, client } = makeService();
    client.phase.findUnique.mockResolvedValue(null);
    await expect(
      service.create(makeActor(), {
        phaseId: 'missing',
        unitNumber: 'A-101',
        bhk: 3,
        price: 1,
      }),
    ).rejects.toThrow(/Phase missing not found/);
    expect(client.unit.create).not.toHaveBeenCalled();
  });
});

// ─── update - admin-only + audit row ────────────────────────────────

describe('update - partial unit update (ADMIN/OWNER only)', () => {
  it('updates the unit and writes an audit row with before/after', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue(unitRow());
    client.unit.update.mockResolvedValue({
      ...unitRow(),
      status: 'SOLD',
      price: { toString: () => '6000000.00' },
    });

    const result = await service.update(makeActor(), 'unit-1', {
      status: 'SOLD',
      price: 6_000_000,
    });

    expect(result.status).toBe('SOLD');
    expect(client.unit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SOLD', price: '6000000.00' }),
      }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'inventory.unit.update',
          before: expect.objectContaining({ status: 'AVAILABLE' }),
          after: expect.objectContaining({ status: 'SOLD' }),
        }),
      }),
    );
  });

  it('rejects TELECALLER (not ADMIN/OWNER)', async () => {
    const { service, client } = makeService();
    await expect(
      service.update(makeActor({ role: 'TELECALLER', sub: 'tc-1' }), 'unit-1', {
        status: 'SOLD',
      }),
    ).rejects.toThrow(/Only ADMIN\/OWNER/);
    expect(client.unit.update).not.toHaveBeenCalled();
  });

  it('returns 404 when the unit does not exist', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue(null);
    await expect(
      service.update(makeActor(), 'missing', { status: 'SOLD' }),
    ).rejects.toThrow(/Unit missing not found/);
    expect(client.unit.update).not.toHaveBeenCalled();
  });
});

// ─── delete - admin-only + booking guard + audit row ─────────────────

describe('delete - remove a unit (ADMIN/OWNER only)', () => {
  it('deletes the unit and writes an audit row when it has no bookings', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue({
      id: 'unit-1',
      phaseId: 'phase-1',
      unitNumber: 'A-101',
      bhk: 3,
      facing: 'North',
      sqft: 1450,
      price: { toString: () => '5800000.00' },
      status: 'AVAILABLE',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      phase: { name: 'Phase A' },
    });
    client.booking.count.mockResolvedValue(0);
    client.unit.delete.mockResolvedValue({ id: 'unit-1' });

    const result = await service.delete(makeActor(), 'unit-1');

    expect(result).toEqual({ id: 'unit-1' });
    expect(client.unit.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'unit-1' } }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'inventory.unit.delete',
          entityType: 'Unit',
          before: expect.objectContaining({ unitNumber: 'A-101' }),
        }),
      }),
    );
  });

  it('rejects TELECALLER (not ADMIN/OWNER)', async () => {
    const { service, client } = makeService();
    await expect(
      service.delete(makeActor({ role: 'TELECALLER', sub: 'tc-1' }), 'unit-1'),
    ).rejects.toThrow(/Only ADMIN\/OWNER/);
    expect(client.unit.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when the unit does not exist', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue(null);
    await expect(service.delete(makeActor(), 'missing')).rejects.toThrow(
      /Unit missing not found/,
    );
    expect(client.unit.delete).not.toHaveBeenCalled();
  });

  it('refuses (409) when the unit has bookings', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue({
      id: 'unit-1',
      phaseId: 'phase-1',
      unitNumber: 'A-101',
      bhk: 3,
      facing: 'North',
      sqft: 1450,
      price: { toString: () => '5800000.00' },
      status: 'HOLD',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      phase: { name: 'Phase A' },
    });
    client.booking.count.mockResolvedValue(2);
    await expect(service.delete(makeActor(), 'unit-1')).rejects.toThrow(
      /has 2 booking/,
    );
    expect(client.unit.delete).not.toHaveBeenCalled();
  });
});
