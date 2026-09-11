// Inventory service tests - exercises the pure logic without a real DB.
//
// Pattern: instantiate InventoryService with a PrismaService stub
// whose $client has the methods we exercise stubbed per-test (mirrors
// bookings.service.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';
import { Prisma } from '@shadhil/database';

import { InventoryService } from './inventory.service';

function makeActor(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'admin-1',
    email: 'admin@shadhilbuilders.in',
    role: 'ADMIN',
    teamId: null,
    organizationId: 'org_bootstrap',
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
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    projectOption: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    project: { findUnique: ReturnType<typeof vi.fn> };
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
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    projectOption: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    project: { findUnique: vi.fn() },
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

// ─── createPhase - manager+ + audit row ───────────────────────────────

describe('createPhase - new phase (MANAGER/ADMIN/OWNER only)', () => {
  it('creates the phase and writes an audit row', async () => {
    const { service, client } = makeService();
    client.project.findUnique.mockResolvedValue({ id: 'proj-1' });
    client.phase.create.mockResolvedValue({
      id: 'phase-9',
      projectId: 'proj-1',
      name: 'Phase D',
    });

    const result = await service.createPhase(makeActor(), {
      projectId: 'proj-1',
      name: 'Phase D',
    });

    expect(result).toEqual({
      id: 'phase-9',
      projectId: 'proj-1',
      name: 'Phase D',
      unitCount: 0,
    });
    expect(client.phase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: 'proj-1', name: 'Phase D' }),
      }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'inventory.phase.create',
          entityType: 'Phase',
        }),
      }),
    );
  });

  it('allows MANAGER (not just ADMIN/OWNER)', async () => {
    const { service, client } = makeService();
    client.project.findUnique.mockResolvedValue({ id: 'proj-1' });
    client.phase.create.mockResolvedValue({
      id: 'phase-9',
      projectId: 'proj-1',
      name: 'Phase D',
    });
    await expect(
      service.createPhase(makeActor({ role: 'MANAGER', sub: 'mgr-1' }), {
        projectId: 'proj-1',
        name: 'Phase D',
      }),
    ).resolves.toMatchObject({ name: 'Phase D' });
  });

  it('rejects TELECALLER (not MANAGER/ADMIN/OWNER)', async () => {
    const { service, client } = makeService();
    await expect(
      service.createPhase(makeActor({ role: 'TELECALLER', sub: 'tc-1' }), {
        projectId: 'proj-1',
        name: 'Phase D',
      }),
    ).rejects.toThrow(/Only MANAGER\/ADMIN\/OWNER/);
    expect(client.phase.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the project does not exist', async () => {
    const { service, client } = makeService();
    client.project.findUnique.mockResolvedValue(null);
    await expect(
      service.createPhase(makeActor(), { projectId: 'missing', name: 'Phase D' }),
    ).rejects.toThrow(/Project missing not found/);
    expect(client.phase.create).not.toHaveBeenCalled();
  });
});

// ─── updatePhase - manager+ + audit row ───────────────────────────────

describe('updatePhase - rename a phase (MANAGER/ADMIN/OWNER only)', () => {
  it('renames the phase and writes an audit row with before/after', async () => {
    const { service, client } = makeService();
    client.phase.findUnique.mockResolvedValue({
      id: 'phase-1',
      projectId: 'proj-1',
      name: 'Phase A',
    });
    client.phase.update.mockResolvedValue({
      id: 'phase-1',
      projectId: 'proj-1',
      name: 'Phase Alpha',
    });

    const result = await service.updatePhase(makeActor(), 'phase-1', {
      name: 'Phase Alpha',
    });

    expect(result).toMatchObject({ name: 'Phase Alpha' });
    expect(client.phase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'Phase Alpha' }),
      }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'inventory.phase.update',
          before: expect.objectContaining({ name: 'Phase A' }),
          after: expect.objectContaining({ name: 'Phase Alpha' }),
        }),
      }),
    );
  });

  it('rejects TELECALLER (not MANAGER/ADMIN/OWNER)', async () => {
    const { service, client } = makeService();
    await expect(
      service.updatePhase(makeActor({ role: 'TELECALLER', sub: 'tc-1' }), 'phase-1', {
        name: 'Phase Alpha',
      }),
    ).rejects.toThrow(/Only MANAGER\/ADMIN\/OWNER/);
    expect(client.phase.update).not.toHaveBeenCalled();
  });

  it('returns 404 when the phase does not exist', async () => {
    const { service, client } = makeService();
    client.phase.findUnique.mockResolvedValue(null);
    await expect(
      service.updatePhase(makeActor(), 'missing', { name: 'Phase Alpha' }),
    ).rejects.toThrow(/Phase missing not found/);
    expect(client.phase.update).not.toHaveBeenCalled();
  });
});

// ─── deletePhase - manager+ + unit guard + audit row ──────────────────

describe('deletePhase - remove a phase (MANAGER/ADMIN/OWNER only)', () => {
  it('deletes the phase and writes an audit row when it has no units', async () => {
    const { service, client } = makeService();
    client.phase.findUnique.mockResolvedValue({
      id: 'phase-1',
      projectId: 'proj-1',
      name: 'Phase A',
    });
    client.unit.count.mockResolvedValue(0);
    client.phase.delete.mockResolvedValue({ id: 'phase-1' });

    const result = await service.deletePhase(makeActor(), 'phase-1');

    expect(result).toEqual({ id: 'phase-1' });
    expect(client.phase.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'phase-1' } }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'inventory.phase.delete',
          entityType: 'Phase',
          before: expect.objectContaining({ name: 'Phase A' }),
        }),
      }),
    );
  });

  it('rejects TELECALLER (not MANAGER/ADMIN/OWNER)', async () => {
    const { service, client } = makeService();
    await expect(
      service.deletePhase(makeActor({ role: 'TELECALLER', sub: 'tc-1' }), 'phase-1'),
    ).rejects.toThrow(/Only MANAGER\/ADMIN\/OWNER/);
    expect(client.phase.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when the phase does not exist', async () => {
    const { service, client } = makeService();
    client.phase.findUnique.mockResolvedValue(null);
    await expect(service.deletePhase(makeActor(), 'missing')).rejects.toThrow(
      /Phase missing not found/,
    );
    expect(client.phase.delete).not.toHaveBeenCalled();
  });

  it('refuses (409) when the phase still has units', async () => {
    const { service, client } = makeService();
    client.phase.findUnique.mockResolvedValue({
      id: 'phase-1',
      projectId: 'proj-1',
      name: 'Phase A',
    });
    client.unit.count.mockResolvedValue(3);
    await expect(service.deletePhase(makeActor(), 'phase-1')).rejects.toThrow(
      /still has 3 unit/,
    );
    expect(client.phase.delete).not.toHaveBeenCalled();
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

  it('returns 409 when the unit number already exists in the phase', async () => {
    const { service, client } = makeService();
    client.phase.findUnique.mockResolvedValue({
      id: 'phase-1',
      name: 'Phase A',
      projectId: 'proj-1',
      project: { name: 'Metro Heights' },
    });
    client.unit.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`phaseId`,`unitNumber`)',
        { code: 'P2002', clientVersion: '7.10.0' },
      ),
    );

    await expect(
      service.create(makeActor(), {
        phaseId: 'phase-1',
        unitNumber: 'A-101',
        bhk: 3,
        price: 1,
      }),
    ).rejects.toThrow(/already exists in this phase/);
    expect(client.auditLog.create).not.toHaveBeenCalled();
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

  it('returns 409 when the new unitNumber collides in the phase', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue(unitRow());
    client.unit.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`phaseId`,`unitNumber`)',
        { code: 'P2002', clientVersion: '7.10.0' },
      ),
    );

    await expect(
      service.update(makeActor(), 'unit-1', { unitNumber: 'A-102' }),
    ).rejects.toThrow(/already exists in this phase/);
    expect(client.auditLog.create).not.toHaveBeenCalled();
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

// ─── options - list ─────────────────────────────────────────────────

describe('options - list a project option set', () => {
  it('returns the project options with real unit counts, narrowed by type', async () => {
    const { service, client } = makeService();
    client.projectOption.findMany.mockResolvedValue([
      { id: 'opt-1', projectId: 'proj-1', type: 'FACING', value: 'North', createdAt: new Date('2026-01-01T00:00:00Z') },
    ]);
    client.unit.count.mockResolvedValue(3);
    const result = await service.options(makeActor(), { projectId: 'proj-1', type: 'FACING' });
    expect(result).toEqual([
      { id: 'opt-1', projectId: 'proj-1', type: 'FACING', value: 'North', unitCount: 3, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    // The count query scopes to units in THIS project using the facing.
    expect(client.unit.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ facing: 'North' }) }),
    );
    expect(client.projectOption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: 'proj-1', type: 'FACING' }) }),
    );
  });

  it('omits the type filter when none is given', async () => {
    const { service, client } = makeService();
    client.projectOption.findMany.mockResolvedValue([]);
    await service.options(makeActor(), { projectId: 'proj-1' });
    expect(client.projectOption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: 'proj-1' }) }),
    );
  });
});

// ─── createOption - manager+ + audit row ─────────────────────────────

describe('createOption - add a project option (MANAGER/ADMIN/OWNER only)', () => {
  it('creates the option and writes an audit row', async () => {
    const { service, client } = makeService();
    client.project.findUnique.mockResolvedValue({ id: 'proj-1' });
    client.projectOption.create.mockResolvedValue({
      id: 'opt-9',
      projectId: 'proj-1',
      type: 'FACING',
      value: 'North-East',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const result = await service.createOption(makeActor(), {
      projectId: 'proj-1',
      type: 'FACING',
      value: 'North-East',
    });
    expect(result).toMatchObject({ type: 'FACING', value: 'North-East' });
    expect(client.projectOption.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: 'proj-1', type: 'FACING', value: 'North-East' }),
      }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'inventory.option.create', entityType: 'ProjectOption' }),
      }),
    );
  });

  it('allows MANAGER (not just ADMIN/OWNER)', async () => {
    const { service, client } = makeService();
    client.project.findUnique.mockResolvedValue({ id: 'proj-1' });
    client.projectOption.create.mockResolvedValue({
      id: 'opt-9',
      projectId: 'proj-1',
      type: 'BHK',
      value: '4',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await expect(
      service.createOption(makeActor({ role: 'MANAGER', sub: 'mgr-1' }), {
        projectId: 'proj-1',
        type: 'BHK',
        value: '4',
      }),
    ).resolves.toMatchObject({ value: '4' });
  });

  it('rejects TELECALLER (not MANAGER/ADMIN/OWNER)', async () => {
    const { service, client } = makeService();
    await expect(
      service.createOption(makeActor({ role: 'TELECALLER', sub: 'tc-1' }), {
        projectId: 'proj-1',
        type: 'FACING',
        value: 'North',
      }),
    ).rejects.toThrow(/Only MANAGER\/ADMIN\/OWNER/);
    expect(client.projectOption.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the project does not exist', async () => {
    const { service, client } = makeService();
    client.project.findUnique.mockResolvedValue(null);
    await expect(
      service.createOption(makeActor(), { projectId: 'missing', type: 'FACING', value: 'North' }),
    ).rejects.toThrow(/Project missing not found/);
    expect(client.projectOption.create).not.toHaveBeenCalled();
  });
});

// ─── deleteOption - manager+ + in-use guard + audit row ──────────────

describe('deleteOption - remove a project option (MANAGER/ADMIN/OWNER only)', () => {
  const facingRow = { id: 'opt-1', projectId: 'proj-1', type: 'FACING', value: 'North' };
  const bhkRow = { id: 'opt-2', projectId: 'proj-1', type: 'BHK', value: '3' };

  it('deletes a facing option when it is not in use and writes an audit row', async () => {
    const { service, client } = makeService();
    client.projectOption.findUnique.mockResolvedValue(facingRow);
    client.unit.count.mockResolvedValue(0);
    client.projectOption.delete.mockResolvedValue({ id: 'opt-1' });
    const result = await service.deleteOption(makeActor(), 'opt-1');
    expect(result).toEqual({ id: 'opt-1' });
    expect(client.projectOption.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'opt-1' } }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'inventory.option.delete', entityType: 'ProjectOption' }),
      }),
    );
  });

  it('deletes a BHK option when it is not in use', async () => {
    const { service, client } = makeService();
    client.projectOption.findUnique.mockResolvedValue(bhkRow);
    client.unit.count.mockResolvedValue(0);
    client.projectOption.delete.mockResolvedValue({ id: 'opt-2' });
    await expect(service.deleteOption(makeActor(), 'opt-2')).resolves.toEqual({ id: 'opt-2' });
  });

  it('rejects TELECALLER (not MANAGER/ADMIN/OWNER)', async () => {
    const { service, client } = makeService();
    await expect(
      service.deleteOption(makeActor({ role: 'TELECALLER', sub: 'tc-1' }), 'opt-1'),
    ).rejects.toThrow(/Only MANAGER\/ADMIN\/OWNER/);
    expect(client.projectOption.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when the option does not exist', async () => {
    const { service, client } = makeService();
    client.projectOption.findUnique.mockResolvedValue(null);
    await expect(service.deleteOption(makeActor(), 'missing')).rejects.toThrow(
      /ProjectOption missing not found/,
    );
    expect(client.projectOption.delete).not.toHaveBeenCalled();
  });

  it('refuses (409) when the facing is in use by a unit in the project', async () => {
    const { service, client } = makeService();
    client.projectOption.findUnique.mockResolvedValue(facingRow);
    client.unit.count.mockResolvedValue(3);
    await expect(service.deleteOption(makeActor(), 'opt-1')).rejects.toThrow(
      /Facing "North" is used by 3 unit/,
    );
    expect(client.projectOption.delete).not.toHaveBeenCalled();
  });

  it('refuses (409) when the BHK is in use by a unit in the project', async () => {
    const { service, client } = makeService();
    client.projectOption.findUnique.mockResolvedValue(bhkRow);
    client.unit.count.mockResolvedValue(2);
    await expect(service.deleteOption(makeActor(), 'opt-2')).rejects.toThrow(
      /BHK 3 is used by 2 unit/,
    );
    expect(client.projectOption.delete).not.toHaveBeenCalled();
  });
});

