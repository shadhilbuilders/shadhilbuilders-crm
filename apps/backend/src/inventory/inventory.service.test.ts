// Inventory service tests - exercises the pure logic without a real DB.
//
// Pattern: instantiate InventoryService with a PrismaService stub
// whose $client has the methods we exercise stubbed per-test (mirrors
// bookings.service.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';
import { Prisma } from '@shadhil/database';
import { UnitStatusSchema } from '@shadhil/api-types';

import { UNIT_STATUS_RANK } from './unit-status-rank';

import { InventoryService } from './inventory.service';

function makeActor(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'admin-1',
    email: 'admin@shadhilbuilders.in',
    role: 'ADMIN',
    organizationId: 'ceid01lpfe1esm8jwsxid41k28',
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
    booking: {
      count: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
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
    booking: { count: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
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
        where: expect.objectContaining({
          // T-SOFT-DELETE (2026-10-01): the grid also drops units whose
          // project is soft-deleted, so the phase filter carries both.
          phase: { projectId: 'proj-1', project: { deletedAt: null } },
        }),
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

// ─── list ordering (T-INV-SORT) ──────────────────────────────────────
//
// The grid lists on-hold units first, then the still-sellable ones, then the
// sold ones. The ORDERING has to come from the server: the grid paginates 10
// at a time, so a client-side sort would order the loaded page and leave the
// remaining units on the wrong pages.
//
// `makeService` is called once per test; two findMany calls happen - first the
// sort keys, then the hydrated page - so the mock is sequenced.

/** Build a sort-key row (the first findMany: id + sort keys only). */
function keyRow(id: string, status: string, phaseId = 'phase-1', unitNumber = id) {
  return { id, status, phaseId, unitNumber };
}

/** Build a hydrated page row. */
function pageRow(id: string, status: string, phaseId = 'phase-1', unitNumber = id) {
  return { ...unitRow(), id, status, phaseId, unitNumber };
}

/** Run list() with the key query returning `keys`, and echo the ids back. */
async function listWithKeys(
  keys: Array<{ id: string; status: string; phaseId: string; unitNumber: string }>,
  dto: { limit: number; offset: number } = { limit: 50, offset: 0 },
) {
  const { service, client } = makeService();
  client.unit.findMany
    .mockResolvedValueOnce(keys)
    .mockImplementationOnce(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => {
        const k = keys.find((x) => x.id === id)!;
        return pageRow(k.id, k.status, k.phaseId, k.unitNumber);
      }),
    );
  client.unit.count.mockResolvedValue(keys.length);
  const result = await service.list(makeActor(), dto);
  return { result, client };
}

describe('list - unit ordering (HOLD first, then AVAILABLE, then SOLD)', () => {
  it('orders HOLD before AVAILABLE before SOLD', async () => {
    const { result } = await listWithKeys([
      keyRow('u-sold', 'SOLD'),
      keyRow('u-avail', 'AVAILABLE'),
      keyRow('u-hold', 'HOLD'),
    ]);
    expect(result.rows.map((r) => r.id)).toEqual(['u-hold', 'u-avail', 'u-sold']);
    expect(result.rows.map((r) => r.status)).toEqual(['HOLD', 'AVAILABLE', 'SOLD']);
  });

  it('places TOKEN after AVAILABLE (still unsold, but not the first call to action)', async () => {
    const { result } = await listWithKeys([
      keyRow('u-token', 'TOKEN'),
      keyRow('u-hold', 'HOLD'),
      keyRow('u-avail', 'AVAILABLE'),
    ]);
    expect(result.rows.map((r) => r.status)).toEqual(['HOLD', 'AVAILABLE', 'TOKEN']);
  });

  it('keeps phase then unit number as the tie-break inside one status', async () => {
    const { result } = await listWithKeys([
      keyRow('u-a2', 'AVAILABLE', 'phase-1', 'A-2'),
      keyRow('u-a1', 'AVAILABLE', 'phase-1', 'A-1'),
      keyRow('u-b1', 'AVAILABLE', 'phase-2', 'B-1'),
    ]);
    expect(result.rows.map((r) => r.id)).toEqual(['u-a1', 'u-a2', 'u-b1']);
  });

  it('sorts an unrecognised status last instead of throwing', async () => {
    // Defensive: a status the rank map does not know must not 500 the grid -
    // it sorts to the tail, where it is visible as a wrong order but harmless.
    const { result } = await listWithKeys([
      keyRow('u-weird', 'MYSTERY'),
      keyRow('u-hold', 'HOLD'),
    ]);
    expect(result.rows.map((r) => r.id)).toEqual(['u-hold', 'u-weird']);
  });

  // The ordering is paginated, so the ORDER BY must be applied BEFORE the
  // slice. If a future change sorted the fetched page instead, page 1 of a
  // sold-first dataset would look right by accident on small data and wrong on
  // real data. This pins the correct page boundaries.
  it('applies the ranking before paginating (page 1 starts with the HOLD unit)', async () => {
    const keys = [
      keyRow('u-sold', 'SOLD'),
      keyRow('u-avail1', 'AVAILABLE'),
      keyRow('u-avail2', 'AVAILABLE'),
      keyRow('u-hold', 'HOLD'),
    ];
    const page1 = await listWithKeys(keys, { limit: 2, offset: 0 });
    expect(page1.result.rows.map((r) => r.id)).toEqual(['u-hold', 'u-avail1']);

    const page2 = await listWithKeys(keys, { limit: 2, offset: 2 });
    expect(page2.result.rows.map((r) => r.id)).toEqual(['u-avail2', 'u-sold']);
  });

  it('hydrates only the requested page, not the whole filtered set', async () => {
    const keys = Array.from({ length: 12 }, (_, i) =>
      keyRow(`u-${String(i).padStart(2, '0')}`, 'AVAILABLE'),
    );
    const { client } = await listWithKeys(keys, { limit: 10, offset: 0 });
    // 1st findMany = keys (no take), 2nd = the page.
    const pageCall = client.unit.findMany.mock.calls[1]![0]!;
    expect(pageCall.where.id.in).toHaveLength(10);
  });

  it('re-asserts the filters on the hydrating query', async () => {
    // The id list is already scoped, but the second query must not become an
    // unscoped read: keep the caller's filters on it too.
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValueOnce([keyRow('u-1', 'HOLD')]);
    client.unit.findMany.mockResolvedValueOnce([pageRow('u-1', 'HOLD')]);
    client.unit.count.mockResolvedValue(1);

    await service.list(makeActor(), {
      projectId: 'proj-1',
      bhk: 3,
      limit: 50,
      offset: 0,
    });

    const pageCall = client.unit.findMany.mock.calls[1]![0]!;
    expect(pageCall.where).toMatchObject({
      phase: { projectId: 'proj-1' },
      bhk: 3,
    });
  });

  it('skips the hydrating query entirely when the page is empty', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValueOnce([]);
    client.unit.count.mockResolvedValue(0);

    const result = await service.list(makeActor(), { limit: 10, offset: 0 });

    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
    // Only the key query ran - no pointless `IN ()` round trip.
    expect(client.unit.findMany).toHaveBeenCalledTimes(1);
  });

  it('ranks EVERY UnitStatus in the Prisma enum', async () => {
    // Guards the single-source-of-truth claim: if a status is added to the
    // schema and not to UNIT_STATUS_RANK it would silently sort last. This
    // fails until it is ranked, which is the point.
    const ranked = new Set(UNIT_STATUS_RANK.map(([s]) => s));
    for (const status of UnitStatusSchema.options) {
      expect(ranked.has(status)).toBe(true);
    }
  });
});

// ─── search by villa number (T-INV-SEARCH) ───────────────────────────
describe('list - search by villa number', () => {
  it('passes a case-insensitive contains on unitNumber to BOTH queries', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValueOnce([]);
    client.unit.count.mockResolvedValue(0);

    await service.list(makeActor(), { search: 'b-2', limit: 10, offset: 0 });

    const keyCall = client.unit.findMany.mock.calls[0]![0]!;
    expect(keyCall.where.OR).toEqual([
      { unitNumber: { contains: 'b-2', mode: 'insensitive' } },
    ]);
    // The count must carry the SAME filter, or the pagination total would
    // advertise rows the grid cannot show.
    const countCall = client.unit.count.mock.calls[0]![0]!;
    expect(countCall.where.OR).toEqual([
      { unitNumber: { contains: 'b-2', mode: 'insensitive' } },
    ]);
  });

  it('combines search with the other filters instead of replacing them', async () => {
    // The `OR` key is the classic collision point: users.service.ts carries a
    // warning because its search block re-assigned an `OR` that already held
    // the project scope, silently dropping it. Here the project filter nests
    // under `phase`, so both must survive.
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValueOnce([]);
    client.unit.count.mockResolvedValue(0);

    await service.list(makeActor(), {
      projectId: 'oe6g1xkagiisnn4oeefpdyhk',
      status: 'AVAILABLE',
      search: 'A-1',
      limit: 10,
      offset: 0,
    });

    const where = client.unit.findMany.mock.calls[0]![0]!.where;
    expect(where).toMatchObject({
      phase: { projectId: 'oe6g1xkagiisnn4oeefpdyhk' },
      status: 'AVAILABLE',
      OR: [{ unitNumber: { contains: 'A-1', mode: 'insensitive' } }],
    });
  });

  it('omits the OR clause entirely when no search is given', async () => {
    // An empty search must not degrade into "match everything" via an empty
    // OR array, and must not add dead SQL to every unfiltered page load.
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValueOnce([]);
    client.unit.count.mockResolvedValue(0);

    await service.list(makeActor(), { limit: 10, offset: 0 });

    const where = client.unit.findMany.mock.calls[0]![0]!.where;
    expect(where.OR).toBeUndefined();
  });

  it('keeps the status ranking on a searched page (search does not bypass T-INV-SORT)', async () => {
    const { service, client } = makeService();
    client.unit.findMany
      .mockResolvedValueOnce([
        keyRow('u-sold', 'SOLD', 'phase-1', 'A-101'),
        keyRow('u-hold', 'HOLD', 'phase-1', 'A-102'),
        keyRow('u-avail', 'AVAILABLE', 'phase-1', 'A-103'),
      ])
      .mockImplementationOnce(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => pageRow(id, id === 'u-hold' ? 'HOLD' : id === 'u-sold' ? 'SOLD' : 'AVAILABLE')),
      );
    client.unit.count.mockResolvedValue(3);

    const result = await service.list(makeActor(), { search: 'A-1', limit: 50, offset: 0 });

    expect(result.rows.map((r) => r.status)).toEqual(['HOLD', 'AVAILABLE', 'SOLD']);
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
    // T-SOFT-DELETE (2026-10-01): the service now loads deletedAt and rejects
    // a soft-deleted project, so the mock models the live row.
    client.project.findUnique.mockResolvedValue({ id: 'proj-1', deletedAt: null });
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
    // T-SOFT-DELETE (2026-10-01): the service now loads deletedAt and rejects
    // a soft-deleted project, so the mock models the live row.
    client.project.findUnique.mockResolvedValue({ id: 'proj-1', deletedAt: null });
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

  // ── T-INV-SYNC (2026-09-15): manual status override vs live bookings ──
  // Unit.status is derived from the booking lifecycle, so the only hand-set
  // values are the off-pipeline marks. Anything that contradicts a live
  // booking (or invents HOLD/TOKEN with no booking behind it) must 409.

  it('409s when marking SOLD but the unit has an approved booking', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue(unitRow({ status: 'AVAILABLE' }));
    client.booking.findMany.mockResolvedValue([{ status: 'APPROVED' }]);

    await expect(
      service.update(makeActor(), 'unit-1', { status: 'AVAILABLE' }),
    ).rejects.toThrow(/live booking/);
    expect(client.unit.update).not.toHaveBeenCalled();
  });

  it('allows SOLD when the unit already has an approved booking', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue(unitRow({ status: 'SOLD' }));
    client.booking.findMany.mockResolvedValue([{ status: 'APPROVED' }]);
    client.unit.update.mockResolvedValue({ ...unitRow(), status: 'SOLD' });

    const result = await service.update(makeActor(), 'unit-1', { status: 'SOLD' });

    expect(result.status).toBe('SOLD');
    expect(client.unit.update).toHaveBeenCalled();
  });

  it('409s when setting HOLD on a unit with no booking behind it', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue(unitRow());
    client.booking.findMany.mockResolvedValue([]);

    await expect(
      // Cast: the DTO no longer accepts HOLD - the service guard is the second
      // line of defence and must 409 if a bad value ever reaches it.
      service.update(makeActor(), 'unit-1', { status: 'HOLD' as 'AVAILABLE' }),
    ).rejects.toThrow(/cannot be set to HOLD/);
    expect(client.unit.update).not.toHaveBeenCalled();
  });

  it('409s when setting TOKEN on a unit with no booking behind it', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue(unitRow());
    client.booking.findMany.mockResolvedValue([]);

    await expect(
      service.update(makeActor(), 'unit-1', { status: 'TOKEN' as 'AVAILABLE' }),
    ).rejects.toThrow(/cannot be set to TOKEN/);
    expect(client.unit.update).not.toHaveBeenCalled();
  });

  it('allows TOKEN when a token booking exists', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue(unitRow({ status: 'TOKEN' }));
    client.booking.findMany.mockResolvedValue([{ status: 'TOKEN' }]);
    client.unit.update.mockResolvedValue({ ...unitRow(), status: 'TOKEN' });

    const result = await service.update(makeActor(), 'unit-1', {
      status: 'TOKEN' as 'AVAILABLE',
    });

    expect(result.status).toBe('TOKEN');
  });

  it('leaves status untouched when the payload does not include one', async () => {
    const { service, client } = makeService();
    client.unit.findUnique.mockResolvedValue(unitRow());
    client.unit.update.mockResolvedValue({
      ...unitRow(),
      price: { toString: () => '6000000.00' },
    });

    await service.update(makeActor(), 'unit-1', { price: 6_000_000 });

    expect(client.booking.findMany).not.toHaveBeenCalled();
    const call = client.unit.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(call.data['status']).toBeUndefined();
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
    // T-SOFT-DELETE (2026-10-01): the service now loads deletedAt and rejects
    // a soft-deleted project, so the mock models the live row.
    client.project.findUnique.mockResolvedValue({ id: 'proj-1', deletedAt: null });
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
    // T-SOFT-DELETE (2026-10-01): the service now loads deletedAt and rejects
    // a soft-deleted project, so the mock models the live row.
    client.project.findUnique.mockResolvedValue({ id: 'proj-1', deletedAt: null });
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

