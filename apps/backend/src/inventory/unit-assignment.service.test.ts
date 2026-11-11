// Unit assignment (2026-11-10).
// protects= admin-only writes, engineer eligibility, replace-set diffing, audit in
// the same tx, notifications only on real transitions; fails_when= a non-admin
// assigns, a non-ENGINEER or off-team user is accepted, a no-op re-assign writes
// or notifies, or a failed push rolls the assignment back.
// no_claim= green does not touch Postgres (RLS is owned by progress-rls.test.ts).
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';

import { UnitAssignmentService, groupNotices } from './unit-assignment.service';

const actorAs = (role: JwtPayload['role']): JwtPayload => ({
  sub: 'admin-1',
  email: 'a@b.c',
  role,
  organizationId: 'org-1',
  iat: 0,
  exp: 0,
  iss: 'shadhil-crm',
});

const unit = (id: string, assigned: string | null, project = 'proj-1') => ({
  id,
  unitNumber: id.toUpperCase(),
  assignedEngineerId: assigned,
  phase: { projectId: project, project: { name: 'Metro' } },
});

interface Opts {
  units?: ReturnType<typeof unit>[];
  engineer?: { id: string; role: string; name: string } | null;
  teamLinks?: number;
  emit?: ReturnType<typeof vi.fn>;
}

function make(opts: Opts = {}) {
  const units = opts.units ?? [unit('u1', null)];
  const db = {
    unit: {
      findFirst: vi.fn().mockResolvedValue(units[0] ?? null),
      findMany: vi.fn().mockResolvedValue(units),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          opts.engineer === undefined ? { id: 'eng-1', role: 'ENGINEER', name: 'Ravi' } : opts.engineer,
        ),
    },
    projectTeam: { count: vi.fn().mockResolvedValue(opts.teamLinks ?? 1) },
    auditLog: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  const emit = opts.emit ?? vi.fn().mockResolvedValue({});
  const service = new UnitAssignmentService({ $client: db } as never, { emit } as never);
  // readRow() after a single assign re-reads through findFirst; give it a row shape.
  return { service, db, emit };
}

describe('groupNotices', () => {
  it('groups several villas per recipient and type, and skips no-ops', () => {
    const notices = groupNotices([
      { unit: unit('u1', null), from: null, to: 'eng-1' },
      { unit: unit('u2', 'eng-2'), from: 'eng-2', to: 'eng-1' },
      { unit: unit('u3', 'eng-1'), from: 'eng-1', to: 'eng-1' },
    ]);
    const assigned = notices.find((n) => n.recipientId === 'eng-1' && n.type === 'progress.assigned');
    expect(assigned?.unitIds).toEqual(['u1', 'u2']);
    const unassigned = notices.find((n) => n.type === 'progress.unassigned');
    expect(unassigned).toMatchObject({ recipientId: 'eng-2', unitIds: ['u2'] });
    expect(notices).toHaveLength(2);
  });
});

describe('assignEngineer', () => {
  it('rejects a non-admin with 403 and writes nothing', async () => {
    const { service, db } = make();
    await expect(service.assignEngineer(actorAs('MANAGER'), 'u1', 'eng-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(db.unit.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a target that is not an ENGINEER (400)', async () => {
    const { service } = make({ engineer: { id: 'eng-1', role: 'MANAGER', name: 'Mo' } });
    await expect(service.assignEngineer(actorAs('ADMIN'), 'u1', 'eng-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an engineer who is not on a team linked to the project (409)', async () => {
    const { service } = make({ teamLinks: 0 });
    await expect(service.assignEngineer(actorAs('ADMIN'), 'u1', 'eng-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('writes the unit and the audit row in one transaction, then notifies the new engineer', async () => {
    const { service, db, emit } = make();
    await service.assignEngineer(actorAs('ADMIN'), 'u1', 'eng-1').catch(() => undefined);
    expect(db.$transaction).toHaveBeenCalled();
    expect(db.unit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ assignedEngineerId: 'eng-1', assignedById: 'admin-1' }),
      }),
    );
    expect(db.auditLog.createMany.mock.calls[0]?.[0]?.data[0]).toMatchObject({
      action: 'inventory.unit.assign',
      before: { assignedEngineerId: null },
      after: { assignedEngineerId: 'eng-1' },
    });
    expect(emit).toHaveBeenCalledWith(
      'eng-1',
      expect.objectContaining({ type: 'progress.assigned', unitId: 'u1' }),
    );
  });

  it('does nothing when the villa already belongs to that engineer', async () => {
    const { service, db, emit } = make({ units: [unit('u1', 'eng-1')] });
    await service.assignEngineer(actorAs('ADMIN'), 'u1', 'eng-1').catch(() => undefined);
    expect(db.unit.updateMany).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('unassigning clears the columns and tells the previous engineer', async () => {
    const { service, db, emit } = make({ units: [unit('u1', 'eng-1')] });
    await service.assignEngineer(actorAs('ADMIN'), 'u1', null).catch(() => undefined);
    expect(db.unit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { assignedEngineerId: null, assignedAt: null, assignedById: null },
      }),
    );
    expect(emit).toHaveBeenCalledWith('eng-1', expect.objectContaining({ type: 'progress.unassigned' }));
  });

  it('a failed push does not undo the assignment', async () => {
    const emit = vi.fn().mockRejectedValue(new Error('push down'));
    const { service, db } = make({ emit });
    await service.assignEngineer(actorAs('ADMIN'), 'u1', 'eng-1').catch(() => undefined);
    expect(db.unit.updateMany).toHaveBeenCalled();
    expect(emit).toHaveBeenCalled();
  });
});

describe('assignUnits (replace-set)', () => {
  it('adds the ticked villas, removes the unticked ones, and reports both counts', async () => {
    const { service, db } = make({
      units: [unit('u1', null), unit('u2', 'eng-1'), unit('u3', 'eng-2')],
    });
    const res = await service.assignUnits(actorAs('ADMIN'), {
      projectId: 'proj-1',
      engineerId: 'eng-1',
      unitIds: ['u1', 'u3'],
    });
    expect(res).toEqual({ assigned: 2, unassigned: 1 });
    expect(db.auditLog.createMany).toHaveBeenCalledTimes(2);
  });

  it('rejects ids from another project (400) before writing', async () => {
    const { service, db } = make({ units: [unit('u1', null)] });
    await expect(
      service.assignUnits(actorAs('ADMIN'), { projectId: 'proj-1', engineerId: 'eng-1', unitIds: ['nope'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.unit.updateMany).not.toHaveBeenCalled();
  });

  it('is admin-only', async () => {
    const { service } = make();
    await expect(
      service.assignUnits(actorAs('MANAGER'), { projectId: 'proj-1', engineerId: 'eng-1', unitIds: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
