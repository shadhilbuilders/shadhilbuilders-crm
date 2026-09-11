// Audit service tests - pure logic + DB-touching stubs.
//
// Pattern: instantiate AuditService with a PrismaService stub whose
// $client has the methods we exercise stubbed per-test.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';

import { AuditService } from './audit.service';

function makeActor(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'admin-1',
    email: 'admin@shadhilbuilders.in',
    role: 'ADMIN',
    teamId: null,
    organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
    ...overrides,
  };
}

function makeService(): {
  service: AuditService;
  client: {
    $transaction: ReturnType<typeof vi.fn>;
    $executeRawUnsafe: ReturnType<typeof vi.fn>;
    auditLog: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };
} {
  const client = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(client),
    ),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    auditLog: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };
  const prismaService = { $client: client } as never;
  const service = new AuditService(prismaService);
  return { service, client };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('list - filterable audit log', () => {
  it('returns total + rows from the audit table', async () => {
    const { service, client } = makeService();
    client.auditLog.findMany.mockResolvedValue([
      {
        id: 'a-1',
        userId: 'u-1',
        action: 'lead.transition',
        entityType: 'Lead',
        entityId: 'l-1',
        before: { state: 'NEW' },
        after: { state: 'CONTACTED' },
        reason: 'demo',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        user: { name: 'Demo Manager' },
      },
    ]);
    client.auditLog.count.mockResolvedValue(1);
    const result = await service.list(makeActor(), {
      limit: 50,
      offset: 0,
    });
    expect(result.total).toBe(1);
    expect(result.rows[0]?.action).toBe('lead.transition');
    expect(result.rows[0]?.userName).toBe('Demo Manager');
    expect(result.rows[0]?.before).toEqual({ state: 'NEW' });
  });

  it('passes entityType + entityId filters into the where clause', async () => {
    const { service, client } = makeService();
    client.auditLog.findMany.mockResolvedValue([]);
    client.auditLog.count.mockResolvedValue(0);
    await service.list(makeActor(), {
      entityType: 'Lead',
      entityId: 'l-1',
      limit: 10,
      offset: 0,
    });
    expect(client.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: 'Lead',
          entityId: 'l-1',
        }),
      }),
    );
  });

  it('passes userId filter into the where clause', async () => {
    const { service, client } = makeService();
    client.auditLog.findMany.mockResolvedValue([]);
    client.auditLog.count.mockResolvedValue(0);
    await service.list(makeActor(), {
      userId: 'u-1',
      limit: 50,
      offset: 0,
    });
    expect(client.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'u-1' }),
      }),
    );
  });

  it('passes from/to date range into createdAt filter', async () => {
    const { service, client } = makeService();
    client.auditLog.findMany.mockResolvedValue([]);
    client.auditLog.count.mockResolvedValue(0);
    await service.list(makeActor(), {
      from: '2026-01-01T00:00:00Z',
      to: '2026-12-31T23:59:59Z',
      limit: 50,
      offset: 0,
    });
    expect(client.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2026-01-01T00:00:00Z'),
            lte: new Date('2026-12-31T23:59:59Z'),
          },
        }),
      }),
    );
  });

  it('returns rows with null userName when the actor was deleted', async () => {
    const { service, client } = makeService();
    client.auditLog.findMany.mockResolvedValue([
      {
        id: 'a-2',
        userId: 'deleted-user',
        action: 'lead.update',
        entityType: 'Lead',
        entityId: 'l-2',
        before: null,
        after: null,
        reason: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        user: null, // user was deleted (userId? is onDelete: SetNull)
      },
    ]);
    client.auditLog.count.mockResolvedValue(1);
    const result = await service.list(makeActor(), {
      limit: 50,
      offset: 0,
    });
    expect(result.rows[0]?.userName).toBeNull();
  });
});
