// Projects service tests - T-ProjectSwitch (2026-09-05).
//
// Pins:
//   1. list: no role narrowing (registry is shared data), orderBy
//      createdAt asc (first project = default active), withRlsContext
//      receives the actor identity.
//   2. create: ADMIN/OWNER pass, MANAGER/TELECALLER/SALES_EXEC 403;
//      slug derived from name, collision suffix appended; audit row
//      written in the same tx.
//   3. update: ADMIN/OWNER pass, staff 403; slug NOT in the update
//      payload even if a caller attempts one; audit before/after.
//   4. remove: SOFT delete - ADMIN/OWNER only (staff 403); 409 when
//      bookings exist; stamps deletedAt (row kept), audit row on success.
//
// Test strategy: stub withRlsContext to invoke the callback with a fake
// tx that records calls and returns canned rows (same as
// teams.service.test.ts).

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

import { ProjectsService, slugifyProjectName } from './projects.service';
import { withRlsContext } from '@shadhil/database';

// Precise mock shapes (no `any` - the backend eslint config has no
// typescript-eslint plugin, so a no-explicit-any disable comment is
// itself an error; see pre-existing failures on teams.service.test.ts).
type MockArgs = Record<string, unknown> & {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
  include?: Record<string, unknown>;
};

type MockProjectRow = {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  reraNumber: string | null;
  cmdaNumber: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  _count?: { leads: number };
};

type MockTx = {
  project: {
    findMany: Mock<(args?: MockArgs) => Promise<MockProjectRow[]>>;
    findUnique: Mock<(args: MockArgs) => Promise<MockProjectRow | null>>;
    create: Mock<(args: MockArgs) => Promise<MockProjectRow>>;
    update: Mock<(args: MockArgs) => Promise<MockProjectRow>>;
    delete: Mock<(args: MockArgs) => Promise<MockProjectRow>>;
    count: Mock<() => Promise<number>>;
  };
  phase: { count: Mock<(args: MockArgs) => Promise<number>> };
  unit: { count: Mock<(args: MockArgs) => Promise<number>> };
  projectOption: {
    createMany: Mock<(args: MockArgs) => Promise<{ count: number }>>;
    count: Mock<(args: MockArgs) => Promise<number>>;
  };
  projectTeam: { count: Mock<(args: MockArgs) => Promise<number>> };
  teamMember: { count: Mock<(args: MockArgs) => Promise<number>> };
  user: {
    findUnique: Mock<
      (args: MockArgs) => Promise<Record<string, unknown> | null>
    >;
    findMany: Mock<
      (args: MockArgs) => Promise<Array<Record<string, unknown>>>
    >;
  };
  lead: {
    count: Mock<(args: MockArgs) => Promise<number>>;
    findMany: Mock<(args: MockArgs) => Promise<Array<Record<string, unknown>>>>;
  };
  booking: { count: Mock<() => Promise<number>> };
  auditLog: { create: Mock<(args: MockArgs) => Promise<unknown>> };
};

const txCapture: { current: MockTx | undefined } = { current: undefined };

function makeTx(overrides: {
  projectFindUnique?: (args: MockArgs) => MockProjectRow | null | undefined;
  bookingCount?: number;
  leadCount?: number;
  memberLeadCount?: number;
  phaseCount?: number;
  unitCount?: number;
  projectOptionCount?: number;
  projectTeamCount?: number;
  teamMemberCount?: number;
  findUser?: (args: MockArgs) => Record<string, unknown> | null;
}): MockTx {
  const projectRows: Record<string, MockProjectRow> = {
    'proj-metro': {
      id: 'proj-metro',
      slug: 'shadhil-metro-heights',
      name: 'Shadhil Metro Heights',
      address: null,
      reraNumber: null,
      cmdaNumber: null,
      createdAt: new Date('2026-09-05T00:00:00.000Z'),
      // Real schema has this column (nullable, NULL = active); the mock must
      // carry it or getDetail's deletedAt guard misfires on undefined.
      deletedAt: null,
    },
  };
  return {
    project: {
      findMany: vi.fn(async () => [
        {
          id: 'proj-metro',
          slug: 'shadhil-metro-heights',
          name: 'Shadhil Metro Heights',
          address: 'Chennai, Tamil Nadu',
          reraNumber: null,
          cmdaNumber: null,
          createdAt: new Date('2026-09-05T00:00:00.000Z'),
        },
      ]),
      findUnique: vi.fn(async (args: MockArgs) => {
        const where = (args.where ?? {}) as { slug?: string; id?: string };
        const bySlug = where.slug !== undefined;
        const key = bySlug
          ? where.slug!.replace(/-\d+$/, '')
          : where.id;
        if (overrides.projectFindUnique) return overrides.projectFindUnique(args);
        if (bySlug) return null; // slug free
        const row = (projectRows[key as string] ?? null) as
          | MockProjectRow
          | null;
        // The service's remove() uses include: { _count: { select: { leads } } }
        if (row !== null && args.include?._count !== undefined) {
          return { ...row, _count: { leads: overrides.leadCount ?? 0 } };
        }
        return row;
      }),
      create: vi.fn(async (args: MockArgs) => {
        const data = (args.data ?? {}) as {
          slug: string;
          name: string;
          address?: string;
          reraNumber?: string | null;
          cmdaNumber?: string | null;
        };
        return {
          id: 'proj-new',
          slug: data.slug,
          name: data.name,
          address: data.address ?? null,
          reraNumber: data.reraNumber ?? null,
          cmdaNumber: data.cmdaNumber ?? null,
          createdAt: new Date('2026-09-05T12:00:00.000Z'),
        };
      }),
      update: vi.fn(async (args: MockArgs) => {
        const where = (args.where ?? {}) as { id?: string };
        const data = (args.data ?? {}) as Partial<MockProjectRow>;
        const base = projectRows[where.id as string] as MockProjectRow;
        return { ...base, ...data };
      }),
      delete: vi.fn(async () => projectRows['proj-metro']),
      count: vi.fn(async () => 3),
    },
    booking: {
      count: vi.fn(async () => overrides.bookingCount ?? 0),
    },
    user: {
      findUnique: vi.fn(
        async (args: MockArgs) =>
          overrides.findUser?.(args) ?? {
            id: 'u-exec',
            name: 'Priya Sharma',
            email: 'priya@shadhilbuilders.in',
            role: 'SALES_EXEC',
          },
      ),
      findMany: vi.fn(async () => []),
    },
    lead: {
      count: vi.fn(async () => overrides.memberLeadCount ?? 0),
      findMany: vi.fn(async () => []),
    },
    projectOption: {
      createMany: vi.fn(async () => ({ count: 9 })),
      count: vi.fn(async () => overrides.projectOptionCount ?? 0),
    },
    projectTeam: {
      count: vi.fn(async () => overrides.projectTeamCount ?? 0),
    },
    teamMember: {
      count: vi.fn(async () => overrides.teamMemberCount ?? 0),
    },
    phase: { count: vi.fn(async () => overrides.phaseCount ?? 0) },
    unit: { count: vi.fn(async () => overrides.unitCount ?? 0) },
    auditLog: {
      create: vi.fn(async () => ({})),
    },
    _counts: { leads: overrides.leadCount ?? 0 },
    _projectRows: projectRows,
  } as unknown as MockTx;
}

vi.mock('@shadhil/database', () => {
  return {
    prisma: {},
    rlsContextFrom: vi.fn((actor: {
      sub: string;
      role: string;
      organizationId?: string | null;
    }) => ({
      userId: actor.sub,
      role: actor.role,
      organizationId: actor.organizationId ?? 'ceid01lpfe1esm8jwsxid41k28',
    })),
    withRlsContext: vi.fn(
      async (
        _client: unknown,
        _ctx: unknown,
                callback: (t: any) => unknown,
      ) => {
        // The service under test receives the tx captured in beforeEach.
        return callback(txCapture.current);
      },
    ),
  };
});

const ownerActor: JwtPayload = {
  sub: 'owner-1',
  email: 'owner@shadhilbuilders.in',
  role: 'OWNER',
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
  iat: 1_000_000,
  exp: 1_000_000 + 3600,
  iss: 'shadhil-bff',
};

const adminActor: JwtPayload = {
  ...ownerActor,
  sub: 'admin-1',
  email: 'admin@shadhilbuilders.in',
  role: 'ADMIN',
};

const managerActor: JwtPayload = {
  ...ownerActor,
  sub: 'mgr-1',
  email: 'manager@shadhilbuilders.in',
  role: 'MANAGER',
};

const telecallerActor: JwtPayload = {
  ...ownerActor,
  sub: 'tc-1',
  email: 'telecaller@shadhilbuilders.in',
  role: 'TELECALLER',
};

describe('slugifyProjectName', () => {
  it('slugifies a normal name', () => {
    expect(slugifyProjectName('Shadhil Metro Heights')).toBe(
      'shadhil-metro-heights',
    );
  });

  it('collapses punctuation and trims dashes', () => {
    expect(slugifyProjectName('  Metro -- Heights  ')).toBe('metro-heights');
  });

  it('falls back to "project" for a name with no alphanumerics', () => {
    expect(slugifyProjectName('***')).toBe('project');
  });

  it('caps the base length at 48 chars', () => {
    expect(slugifyProjectName('x'.repeat(80)).length).toBeLessThanOrEqual(48);
  });
});

describe('ProjectsService.list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCapture.current = makeTx({});
  });

  it('passes the actor identity to withRlsContext', async () => {
    const svc = new ProjectsService({ $client: {} } as never);
    await svc.list(telecallerActor);
    expect(withRlsContext).toHaveBeenCalledTimes(1);
    const ctx = (withRlsContext as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]![1];
    expect(ctx).toEqual({
      userId: 'tc-1',
      role: 'TELECALLER',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
  });

  it('orders by createdAt asc with no membership filter (registry is shared)', async () => {
    const svc = new ProjectsService({ $client: {} } as never);
    const tx = txCapture.current!;
    const result = await svc.list(telecallerActor);
    const args = (tx.project.findMany.mock.calls[0]![0] as any);
    // T-SOFT-DELETE: only active rows; still no role/membership narrowing.
    expect(args.where).toEqual({ deletedAt: null });
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
    expect(result.total).toBe(3);
    expect(result.projects[0]!.name).toBe('Shadhil Metro Heights');
  });

  it('applies server-side search + pagination when a filter is provided', async () => {
    const svc = new ProjectsService({ $client: {} } as never);
    const tx = txCapture.current!;
    const result = await svc.list(telecallerActor, {
      search: 'metr',
      limit: 10,
      offset: 20,
    });
    const args = (tx.project.findMany.mock.calls[0]![0] as any);
    // T-PROJ-SRVPG: search ANDed with deletedAt, skip/take from limit/offset.
    expect(args.where).toEqual({
      deletedAt: null,
      OR: [
        { name: { contains: 'metr', mode: 'insensitive' } },
        { slug: { contains: 'metr', mode: 'insensitive' } },
      ],
    });
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
    expect(result.projects).toHaveLength(1);
  });
});

describe('ProjectsService.create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCapture.current = makeTx({});
  });

  it('ADMIN can create; slug is derived and audit row written', async () => {
    const svc = new ProjectsService({ $client: {} } as never);
    const tx = txCapture.current!;
    const row = await svc.create(adminActor, {
      name: 'Shadhil Skyline Towers',
      address: 'Whitefield, Bengaluru',
    });
    expect(row.slug).toBe('shadhil-skyline-towers');
        const audit = (tx.auditLog.create.mock.calls[0]![0] as any);
    expect(audit.data.action).toBe('project.create');
    expect(audit.data.entityType).toBe('Project');

    // The default facing/BHK option set is auto-seeded for the new project
    // so its inventory pickers are usable immediately.
    expect(tx.projectOption.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          {
            organizationId: 'ceid01lpfe1esm8jwsxid41k28',
            projectId: 'proj-new',
            type: 'FACING',
            value: 'North',
          },
          {
            organizationId: 'ceid01lpfe1esm8jwsxid41k28',
            projectId: 'proj-new',
            type: 'BHK',
            value: '3',
          },
        ]),
      }),
    );
  });

  it('appends a suffix when the slug is taken', async () => {
    const svc = new ProjectsService({ $client: {} } as never);
    const tx = txCapture.current!;
    // Make the first slug lookup find a clash.
    tx.project.findUnique = vi.fn(async (args: MockArgs) => {
      const where = (args.where ?? {}) as {
        slug?: string;
        organizationId_slug?: { organizationId?: string; slug?: string };
      };
      const slug =
        where.organizationId_slug?.slug ?? where.slug;
      if (slug === 'shadhil-skyline-towers') {
        return {
          id: 'existing',
          slug: 'shadhil-skyline-towers',
          name: 'Existing',
          address: null,
          reraNumber: null,
          cmdaNumber: null,
          createdAt: new Date('2026-09-05T00:00:00.000Z'),
          deletedAt: null,
        };
      }
      return null;
    });
    const row = await svc.create(adminActor, {
      name: 'Shadhil Skyline Towers',
      address: 'Whitefield, Bengaluru',
    });
    expect(row.slug).toBe('shadhil-skyline-towers-2');
  });

  it('MANAGER is rejected with 403 (no tx opened)', async () => {
    const svc = new ProjectsService({ $client: {} } as never);
    const tx = txCapture.current!;
    await expect(
      svc.create(managerActor, { name: 'Rogue Project', address: 'Nowhere' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(tx.project.create).not.toHaveBeenCalled();
  });

  it('TELECALLER is rejected with 403', async () => {
    const svc = new ProjectsService({ $client: {} } as never);
    await expect(
      svc.create(telecallerActor, { name: 'Rogue Project', address: 'Nowhere' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('ProjectsService.update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCapture.current = makeTx({});
  });

  it('ADMIN can rename and audit records before/after', async () => {
    const svc = new ProjectsService({ $client: {} } as never);
    const tx = txCapture.current!;
    const row = await svc.update(adminActor, 'proj-metro', {
      name: 'Shadhil Metro Heights Phase 2',
    });
    expect(row.name).toBe('Shadhil Metro Heights Phase 2');
        const audit = (tx.auditLog.create.mock.calls[0]![0] as any);
    expect(audit.data.action).toBe('project.update');
    expect(audit.data.before.name).toBe('Shadhil Metro Heights');
  });

  it('a caller-supplied slug is ignored (slug immutable)', async () => {
    const svc = new ProjectsService({ $client: {} } as never);
    const tx = txCapture.current!;
    // Runtime callers sending a slug (DTO parse strips unknown keys in
    // the controller, but the service must ALSO not spread it through)
    // - cast through unknown to simulate a hand-built body object.
    const hostile = { name: 'Renamed', slug: 'hijacked' } as unknown as Parameters<
      ProjectsService['update']
    >[2];
    await svc.update(adminActor, 'proj-metro', hostile);
        const args = (tx.project.update.mock.calls[0]![0] as any);
    expect(args.data.slug).toBeUndefined();
  });

  it('MANAGER is rejected with 403', async () => {
    const svc = new ProjectsService({ $client: {} } as never);
    await expect(
      svc.update(managerActor, 'proj-metro', { name: 'X' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('unknown project id → 404', async () => {
    const svc = new ProjectsService({ $client: {} } as never);
    await expect(
      svc.update(adminActor, 'proj-ghost', { name: 'X' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('ProjectsService.remove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ADMIN can soft-delete a project without bookings; audit row written', async () => {
    txCapture.current = makeTx({ bookingCount: 0, leadCount: 4 });
    const svc = new ProjectsService({ $client: {} } as never);
    const tx = txCapture.current!;
    const result = await svc.remove(adminActor, 'proj-metro');
    expect(result).toEqual({ id: 'proj-metro' });
    // T-SOFT-DELETE: project is updated (deletedAt stamped), NOT hard-deleted.
    expect(tx.project.delete).not.toHaveBeenCalled();
    expect(tx.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'proj-metro' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
    const audit = (tx.auditLog.create.mock.calls[0]![0] as any);
    expect(audit.data.action).toBe('project.delete');
    expect(audit.data.before.leadCount).toBe(4);
  });

  it('TELECALLER is rejected with 403 (admin/owner-only delete)', async () => {
    txCapture.current = makeTx({});
    const svc = new ProjectsService({ $client: {} } as never);
    const tx = txCapture.current!;
    await expect(
      svc.remove(telecallerActor, 'proj-metro'),
    ).rejects.toMatchObject({ status: 403 });
    expect(tx.project.update).not.toHaveBeenCalled();
  });

  it('409 when the project still has bookings', async () => {
    txCapture.current = makeTx({ bookingCount: 5 });
    const svc = new ProjectsService({ $client: {} } as never);
    const tx = txCapture.current!;
    await expect(
      svc.remove(ownerActor, 'proj-metro'),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.project.update).not.toHaveBeenCalled();
  });

  it('unknown project id → 404', async () => {
    txCapture.current = makeTx({});
    const svc = new ProjectsService({ $client: {} } as never);
    await expect(
      svc.remove(ownerActor, 'proj-ghost'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('ProjectsService.getDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCapture.current = makeTx({});
  });

  it('returns identity + per-project counts for an ADMIN', async () => {
    txCapture.current = makeTx({
      bookingCount: 7,
      memberLeadCount: 12,
      phaseCount: 3,
      unitCount: 40,
      projectOptionCount: 9,
      projectTeamCount: 2,
      teamMemberCount: 5,
    });
    const svc = new ProjectsService({ $client: {} } as never);
    const result = await svc.getDetail(adminActor, 'proj-metro');
    expect(result).toMatchObject({
      id: 'proj-metro',
      slug: 'shadhil-metro-heights',
      name: 'Shadhil Metro Heights',
      counts: {
        phases: 3,
        units: 40,
        options: 9,
        teams: 2,
        teamMembers: 5,
        leads: 12,
        bookings: 7,
      },
    });
  });

  it('rejects a non-admin (TELECALLER) with 403', async () => {
    const svc = new ProjectsService({ $client: {} } as never);
    await expect(
      svc.getDetail(telecallerActor, 'proj-metro'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('unknown project id → 404', async () => {
    const svc = new ProjectsService({ $client: {} } as never);
    await expect(
      svc.getDetail(adminActor, 'proj-ghost'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
