// Notifications service tests - pure logic + DB-touching stubs.
//
// Pattern: instantiate NotificationsService with a PrismaService
// stub whose $client has the methods we exercise stubbed per-test.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';

import { NotificationsService } from './notifications.service';

function makeActor(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'u-1',
    email: 'u@shadhilbuilders.in',
    role: 'TELECALLER',
    teamId: null,
    organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
    ...overrides,
  };
}

function makeService(): {
  service: NotificationsService;
  client: {
    $transaction: ReturnType<typeof vi.fn>;
    $executeRawUnsafe: ReturnType<typeof vi.fn>;
    notification: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    auditLog: { create: ReturnType<typeof vi.fn> };
  };
} {
  const client = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(client),
    ),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    notification: {
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'a-1' }) },
  };
  const prismaService = { $client: client } as never;
  const service = new NotificationsService(prismaService);
  return { service, client };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('list - current-user inbox', () => {
  it('returns total, unread count, and rows', async () => {
    const { service, client } = makeService();
    client.notification.findMany.mockResolvedValue([
      {
        id: 'n1',
        type: 'lead.assigned',
        title: 'A',
        body: 'a',
        leadId: 'l-1',
        read: false,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    client.notification.count
      .mockResolvedValueOnce(1) // total (unfiltered)
      .mockResolvedValueOnce(3); // unread

    const result = await service.list(makeActor(), {
      unreadOnly: false,
      limit: 50,
      offset: 0,
    });
    expect(result.total).toBe(1);
    expect(result.unread).toBe(3);
    expect(result.rows[0]?.id).toBe('n1');
  });

  it('filters to unread when unreadOnly=true', async () => {
    const { service, client } = makeService();
    client.notification.findMany.mockResolvedValue([]);
    client.notification.count.mockResolvedValue(0);
    await service.list(makeActor(), {
      unreadOnly: true,
      limit: 50,
      offset: 0,
    });
    expect(client.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ read: false }),
      }),
    );
  });

  it('filters by typePrefix (e.g. lead → lead.*)', async () => {
    const { service, client } = makeService();
    client.notification.findMany.mockResolvedValue([]);
    client.notification.count.mockResolvedValue(0);
    await service.list(makeActor(), {
      typePrefix: 'lead',
      unreadOnly: false,
      limit: 50,
      offset: 0,
    });
    expect(client.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: { startsWith: 'lead' },
        }),
      }),
    );
  });
});

describe('markRead - batch update + audit row', () => {
  it('updates the listed IDs and writes an audit row', async () => {
    const { service, client } = makeService();
    client.notification.updateMany.mockResolvedValue({ count: 2 });
    const result = await service.markRead(makeActor(), {
      notificationIds: ['n1', 'n2'],
    });
    expect(result).toEqual({ updated: 2 });
    expect(client.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u-1',
          read: false,
          id: { in: ['n1', 'n2'] },
        }),
        data: { read: true },
      }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'notification.markRead',
          entityType: 'Notification',
        }),
      }),
    );
  });

  it('empty ids = mark all unread (no id IN clause)', async () => {
    const { service, client } = makeService();
    client.notification.updateMany.mockResolvedValue({ count: 5 });
    const result = await service.markRead(makeActor(), {
      notificationIds: [],
    });
    expect(result).toEqual({ updated: 5 });
    expect(client.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u-1',
          read: false,
        }),
      }),
    );
    // The `id` clause should NOT be present when array is empty -
    // updateMany hits every unread row.
    const call = client.notification.updateMany.mock.calls[0]?.[0];
    expect(call?.where).not.toHaveProperty('id');
  });
});

describe('emit - service hook for notification creation', () => {
  it('inserts a notification for the recipient and writes an audit row', async () => {
    const { service, client } = makeService();
    client.notification.create.mockResolvedValue({
      id: 'n-new',
      type: 'lead.assigned',
      title: 'You have a new lead',
      body: 'Test Lead A',
      leadId: 'l-1',
      read: false,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = await service.emit('recipient-1', {
      type: 'lead.assigned',
      title: 'You have a new lead',
      body: 'Test Lead A',
      leadId: 'l-1',
    });
    expect(result.id).toBe('n-new');
    expect(client.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'recipient-1',
          type: 'lead.assigned',
          title: 'You have a new lead',
          body: 'Test Lead A',
          leadId: 'l-1',
          read: false,
        }),
      }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'notification.emit',
          entityType: 'Notification',
        }),
      }),
    );
  });

  it('rejects empty recipientSub', async () => {
    const { service, client } = makeService();
    await expect(
      service.emit('', {
        type: 'lead.assigned',
        title: 'x',
        body: 'x',
      }),
    ).rejects.toThrow(/recipientSub/);
    expect(client.notification.create).not.toHaveBeenCalled();
  });
});
