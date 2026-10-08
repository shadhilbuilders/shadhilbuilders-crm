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
    user: { findUnique: ReturnType<typeof vi.fn> };
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
    user: {
      findUnique: vi.fn().mockResolvedValue({ organizationId: 'org-of-recipient' }),
    },
  };
  const prismaService = { $client: client } as never;
  const service = new NotificationsService(prismaService);
  return { service, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PUBLIC_ORG_ID', 'ceid01lpfe1esm8jwsxid41k28');
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

  it('builds the real app deep-link URL on push (orgSlug/projectSlug/leads/id)', async () => {
    // Regression: pushBestEffort used to emit a bare `/leads/{id}` which the
    // app does not route. It must resolve the ORG + PROJECT slugs from the lead
    // and build `/{orgSlug}/projects/{projectSlug}/leads/{leadId}`.
    const sendToUser = vi.fn().mockResolvedValue(1);
    const push = { sendToUser } as never;
    const client = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
      notification: {
        create: vi.fn().mockResolvedValue({
          id: 'n-push',
          type: 'lead.assigned',
          title: 'You have a new lead',
          body: 'Test Lead A',
          leadId: 'l-1',
          read: false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'a-1' }) },
      user: { findUnique: vi.fn().mockResolvedValue({ organizationId: 'org-1' }) },
      lead: {
        findUnique: vi.fn().mockResolvedValue({
          organizationId: 'org-1',
          project: { slug: 'metro-heights' },
          organization: { slug: 'shadhil-builders' },
        }),
      },
    } as never;
    const prismaService = { $client: client } as never;
    const service = new NotificationsService(prismaService, push);

    await service.emit('recipient-1', {
      type: 'lead.assigned',
      title: 'You have a new lead',
      body: 'Test Lead A',
      leadId: 'l-1',
    });

    // pushBestEffort is fire-and-forget async; flush the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    expect(sendToUser).toHaveBeenCalledWith(
      'recipient-1',
      expect.objectContaining({
        url: '/shadhil-builders/projects/metro-heights/leads/l-1',
      }),
      'org-1',
    );
  });

  it('deep-links a booking notification to the booking page, not the lead page', async () => {
    // Regression: booking notifications used to deep-link to the lead page.
    // With bookingId present, the push must go to
    // `/{orgSlug}/projects/{projectSlug}/bookings/{bookingId}`.
    const sendToUser = vi.fn().mockResolvedValue(1);
    const push = { sendToUser } as never;
    const client = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
      notification: {
        create: vi.fn().mockResolvedValue({
          id: 'n-booking',
          type: 'booking.created',
          title: 'Booking on hold',
          body: 'Booking for Demo Priya',
          leadId: 'l-1',
          read: false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'a-1' }) },
      user: { findUnique: vi.fn().mockResolvedValue({ organizationId: 'org-1' }) },
      lead: {
        findUnique: vi.fn().mockResolvedValue({
          project: { slug: 'metro-heights' },
          organization: { slug: 'shadhil-builders' },
        }),
      },
    } as never;
    const prismaService = { $client: client } as never;
    const service = new NotificationsService(prismaService, push);

    await service.emit('recipient-1', {
      type: 'booking.created',
      title: 'Booking on hold',
      body: 'Booking for Demo Priya',
      leadId: 'l-1',
      bookingId: 'b-42',
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(sendToUser).toHaveBeenCalledWith(
      'recipient-1',
      expect.objectContaining({
        url: '/shadhil-builders/projects/metro-heights/bookings/b-42',
      }),
      'org-1',
    );
  });

  it('stamps the recipient\'s own organization, never PUBLIC_ORG_ID', async () => {
    const { service, client } = makeService();
    client.notification.create.mockResolvedValue({
      id: 'n-org', type: 't', title: 't', body: 'b', leadId: null, read: false,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await service.emit('recipient-1', { type: 't', title: 't', body: 'b' });
    expect(client.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'recipient-1' } }),
    );
    expect(client.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: 'org-of-recipient' }),
      }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: 'org-of-recipient' }),
      }),
    );
  });

  it('uses an explicit organizationId without looking the user up', async () => {
    const { service, client } = makeService();
    client.notification.create.mockResolvedValue({
      id: 'n-org2', type: 't', title: 't', body: 'b', leadId: null, read: false,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await service.emit('recipient-1', {
      type: 't', title: 't', body: 'b', organizationId: 'org-explicit',
    });
    expect(client.user.findUnique).not.toHaveBeenCalled();
    expect(client.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: 'org-explicit' }),
      }),
    );
  });

  it('fails loudly when the recipient or their organization cannot be resolved', async () => {
    const { service, client } = makeService();
    client.user.findUnique.mockResolvedValue(null);
    await expect(
      service.emit('ghost', { type: 't', title: 't', body: 'b' }),
    ).rejects.toThrow(/Cannot resolve the organization/);
    expect(client.notification.create).not.toHaveBeenCalled();
  });
});
