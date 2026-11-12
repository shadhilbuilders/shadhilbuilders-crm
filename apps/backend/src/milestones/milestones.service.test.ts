// MilestonesService - list + replace-all of a project's buyer-visible checkpoints.
//
// protects= only ADMIN/OWNER may replace; a missing project is a 404; the replace
//           is delete+insert in ONE transaction with the audit row in the same
//           tx; staff order is preserved via sortOrder; reads are open to any
//           staff role (RLS narrows the rest).
// fails_when= a MANAGER can write, the audit row lands outside the tx, order is
//           re-sorted by date, or an unknown project is silently accepted.
// no_claim= does NOT touch a real database; RLS is owned by
//           packages/database/test/project-milestone-rls.test.ts.
import { ForbiddenException, NotFoundException } from '@nestjs/common';
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

import { MilestonesService } from './milestones.service';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const NOW = Math.floor(Date.now() / 1000);
const actor = (role: JwtPayload['role']): JwtPayload => ({
  sub: 'u-1',
  email: 'u-1@x.in',
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

const row = (id: string, name: string, targetDate: Date | null, completedAt: Date | null) => ({
  id,
  name,
  targetDate,
  completedAt,
});

function tx(overrides: Record<string, unknown> = {}) {
  return {
    project: { findUnique: vi.fn(async () => ({ id: 'p-1' })) },
    projectMilestone: {
      findMany: vi.fn(async (): Promise<Array<ReturnType<typeof row>>> => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    ...overrides,
  };
}

describe('MilestonesService', () => {
  let svc: MilestonesService;
  beforeEach(() => {
    svc = new MilestonesService(prismaStub);
    setTx(tx());
  });

  it('list: returns rows in staff order with ISO dates', async () => {
    const t = tx({
      projectMilestone: {
        findMany: vi.fn(async () => [
          row('m1', 'Slab cast', new Date(Date.UTC(2027, 0, 15)), new Date(Date.UTC(2027, 0, 10))),
          row('m2', 'Handover', null, null),
        ]),
      },
    });
    setTx(t);
    const res = await svc.list(actor('MANAGER'), 'p-1');
    expect(res).toEqual([
      {
        id: 'm1',
        name: 'Slab cast',
        targetDate: '2027-01-15T00:00:00.000Z',
        completedAt: '2027-01-10T00:00:00.000Z',
      },
      { id: 'm2', name: 'Handover', targetDate: null, completedAt: null },
    ]);
    expect(t.projectMilestone.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'p-1', organizationId: ORG },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it.each(['MANAGER', 'SALES_EXEC', 'TELECALLER', 'ENGINEER', 'CUSTOMER'] as const)(
    'replace: %s is forbidden',
    async (role) => {
      await expect(svc.replace(actor(role), 'p-1', { milestones: [] })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    },
  );

  it('replace: 404 for a project the actor cannot see', async () => {
    setTx(tx({ project: { findUnique: vi.fn(async () => null) } }));
    await expect(svc.replace(actor('ADMIN'), 'nope', { milestones: [] })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('replace: deletes then inserts in staff order, and audits in the same tx', async () => {
    const t = tx();
    // After the insert the service re-reads, so list() sees the new rows.
    t.projectMilestone.findMany = vi.fn(async () => [row('n1', 'Plinth', null, null)]);
    setTx(t);
    const res = await svc.replace(actor('OWNER'), 'p-1', {
      milestones: [
        { name: ' Plinth ', targetDate: '2027-03-01T00:00:00.000Z' },
        { name: 'Slab cast', completedAt: '2027-02-01T00:00:00.000Z' },
      ],
    });
    expect(t.projectMilestone.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 'p-1', organizationId: ORG },
    });
    expect(t.projectMilestone.createMany).toHaveBeenCalledWith({
      data: [
        {
          projectId: 'p-1',
          organizationId: ORG,
          name: ' Plinth ',
          targetDate: new Date('2027-03-01T00:00:00.000Z'),
          completedAt: null,
          sortOrder: 0,
        },
        {
          projectId: 'p-1',
          organizationId: ORG,
          name: 'Slab cast',
          targetDate: null,
          completedAt: new Date('2027-02-01T00:00:00.000Z'),
          sortOrder: 1,
        },
      ],
    });
    expect(t.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'project.milestones.replace',
          entityType: 'Project',
          entityId: 'p-1',
          organizationId: ORG,
        }),
      }),
    );
    expect(res).toHaveLength(1);
  });

  it('replace: an empty list clears and does not call createMany', async () => {
    const t = tx();
    setTx(t);
    await svc.replace(actor('ADMIN'), 'p-1', { milestones: [] });
    expect(t.projectMilestone.deleteMany).toHaveBeenCalled();
    expect(t.projectMilestone.createMany).not.toHaveBeenCalled();
  });
});
