// InventoryService.plots() - CMDA plot availability derivation.
//
// Separate file from `inventory.service.test.ts` so the plot-status contract
// gets its own focused harness: this method's whole job is turning units into
// plot statuses, and the interesting cases are all about what it must REFUSE
// (a marketing unit number is not a plot) and what it must never do (paint a
// sold plot as available).
//
// Pure unit tests against a stubbed client - no database. `withRlsContext`
// works against the stub because it only needs `$transaction` and
// `$executeRawUnsafe`, both of which the harness provides.

import { UnitStatusSchema } from '@shadhil/api-types';
import type { JwtPayload } from '@shadhil/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InventoryService } from './inventory.service';

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
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    unit: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const prismaService = { $client: client } as never;
  return { service: new InventoryService(prismaService), client };
}

/** A unit row as `select: { unitNumber, status }` returns it. */
function unit(unitNumber: string, status: string) {
  return { unitNumber, status };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('plots - unit number is the only bridge to a plot', () => {
  it('reads a plot-numbered unit as that plot, with the unit status mapped across', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([unit('37', 'AVAILABLE')]);

    await expect(service.plots(makeActor(), 'proj-1')).resolves.toEqual({
      rows: [{ plotNumber: 37, status: 'available' }],
    });
  });

  it('maps SOLD to booked and HOLD/TOKEN to blocked', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([
      unit('1', 'SOLD'),
      unit('2', 'HOLD'),
      unit('3', 'TOKEN'),
      unit('4', 'AVAILABLE'),
    ]);

    await expect(service.plots(makeActor(), 'proj-1')).resolves.toEqual({
      rows: [
        { plotNumber: 1, status: 'booked' },
        { plotNumber: 2, status: 'blocked' },
        { plotNumber: 3, status: 'blocked' },
        { plotNumber: 4, status: 'available' },
      ],
    });
  });

  it('ignores a unit whose number is not a plot number, even if it reaches the service', async () => {
    // The SQL filter should exclude these, but the JS side must not trust that:
    // "D-101" is a real unit number in this repository and reading it as plot
    // 101 would paint an unrelated plot.
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([
      unit('D-101', 'SOLD'),
      unit('A-12', 'HOLD'),
      unit('Villa 3', 'AVAILABLE'),
      unit('', 'AVAILABLE'),
      unit('0', 'SOLD'),
      unit('126', 'SOLD'),
      unit('037', 'SOLD'),
    ]);

    await expect(service.plots(makeActor(), 'proj-1')).resolves.toEqual({ rows: [] });
  });

  it('filters in SQL to the plot numbers rather than fetching a whole project', async () => {
    const { service, client } = makeService();
    await service.plots(makeActor(), 'proj-1');

    const call = client.unit.findMany.mock.calls[0]?.[0] as {
      where: { unitNumber: { in: string[] }; phase?: { projectId: string } };
      select: Record<string, boolean>;
    };
    expect(call.where.phase).toEqual({ projectId: 'proj-1' });
    expect(call.where.unitNumber.in).toContain('1');
    expect(call.where.unitNumber.in).toContain('125');
    expect(call.where.unitNumber.in).not.toContain('126');
    expect(call.where.unitNumber.in).not.toContain('D-101');
    expect(call.select).toEqual({ unitNumber: true, status: true });
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

describe('plots - conflicts and ordering', () => {
  it('lets the most binding claim win when two phases number a unit the same', async () => {
    // Unit is unique on (phaseId, unitNumber), so two phases of one project can
    // both hold a unit "37". A sold plot must never read available.
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([
      unit('37', 'AVAILABLE'),
      unit('37', 'SOLD'),
      unit('40', 'AVAILABLE'),
      unit('40', 'HOLD'),
      unit('41', 'AVAILABLE'),
    ]);

    await expect(service.plots(makeActor(), 'proj-1')).resolves.toEqual({
      rows: [
        { plotNumber: 37, status: 'booked' },
        { plotNumber: 40, status: 'blocked' },
        { plotNumber: 41, status: 'available' },
      ],
    });
  });

  it('returns rows sorted by plot number', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([
      unit('99', 'AVAILABLE'),
      unit('7', 'AVAILABLE'),
      unit('42', 'AVAILABLE'),
    ]);

    const { rows } = await service.plots(makeActor(), 'proj-1');
    expect(rows.map((row) => row.plotNumber)).toEqual([7, 42, 99]);
  });

  it('returns an empty row set when nothing is plot-numbered', async () => {
    // Today's real state: 0 of the database's units have a plot-numbered name.
    // This is a normal answer, not an error - the map then reads all available.
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([]);
    await expect(service.plots(makeActor(), 'proj-1')).resolves.toEqual({ rows: [] });
  });

  it('emits every row through the shared schema without loss', async () => {
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue(
      UnitStatusSchema.options.map((status, index) => unit(String(index + 1), status)),
    );

    const { rows } = await service.plots(makeActor(), 'proj-1');
    expect(rows).toHaveLength(UnitStatusSchema.options.length);
    for (const row of rows) {
      expect(Number.isInteger(row.plotNumber)).toBe(true);
      expect(['available', 'booked', 'blocked']).toContain(row.status);
    }
  });
});

describe('plots - unknown unit status fails loudly', () => {
  it('throws rather than painting an unrecognised status as available', async () => {
    // A status the shared contract does not know means the database and the
    // generated client have drifted. Guessing a colour would be worse than a
    // 500, because every surface would then be silently wrong.
    const { service, client } = makeService();
    client.unit.findMany.mockResolvedValue([unit('37', 'RESERVED_BY_ALIENS')]);

    await expect(service.plots(makeActor(), 'proj-1')).rejects.toThrow(/not a known UnitStatus/);
  });
});
