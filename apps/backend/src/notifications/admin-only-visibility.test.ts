// Admin-only notification visibility (2026-11-21).
//
// protects= `feedback.created` rows are served ONLY to ADMIN/OWNER, on all three
//           read paths: the REST list, the unread badge count, and the SSE
//           stream. A non-admin's `where` carries an explicit exclusion;
// fails_when= a demoted ADMIN keeps seeing (and badging) feedback rows whose only
//           destination `/{orgSlug}/admin/feedback` 403s for them, or the
//           exclusion clobbers the tab's own type/typePrefix filter;
// why a READ gate at all: the emit-time audience (live ADMIN/OWNER rows) is
//           correct but a Notification row is keyed by userId and outlives the
//           role that earned it - roles change, rows do not.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';

import { NotificationsService } from './notifications.service';

const ADMIN_ONLY = { type: { in: ['feedback.created'] } };

function makeActor(role: JwtPayload['role']): JwtPayload {
  return {
    sub: 'u-1',
    email: 'u@shadhilbuilders.in',
    role,
    organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

function makeService() {
  const client = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    notification: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'a-1' }) },
    user: { findUnique: vi.fn().mockResolvedValue({ organizationId: 'org-1' }) },
    lead: { findMany: vi.fn().mockResolvedValue([]) },
    unit: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return { service: new NotificationsService({ $client: client } as never), client };
}

const defaultQuery = { unreadOnly: false, limit: 50, offset: 0 } as const;

beforeEach(() => vi.clearAllMocks());

describe('list - admin-only types are hidden from non-admins', () => {
  it('protects= a TELECALLER is never served feedback notifications', async () => {
    const { service, client } = makeService();
    await service.list(makeActor('TELECALLER'), { ...defaultQuery });

    const where = client.notification.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ NOT: ADMIN_ONLY });
  });

  it('protects= the same gate applies to MANAGER, SALES_EXEC and ENGINEER', async () => {
    for (const role of ['MANAGER', 'SALES_EXEC', 'ENGINEER'] as const) {
      const { service, client } = makeService();
      await service.list(makeActor(role), { ...defaultQuery });
      const where = client.notification.findMany.mock.calls[0]?.[0]?.where;
      expect(where, `${role} must not see admin-only rows`).toMatchObject({ NOT: ADMIN_ONLY });
    }
  });

  it('protects= ADMIN and OWNER see everything (no exclusion clause)', async () => {
    for (const role of ['ADMIN', 'OWNER'] as const) {
      const { service, client } = makeService();
      await service.list(makeActor(role), { ...defaultQuery });
      const where = client.notification.findMany.mock.calls[0]?.[0]?.where;
      expect(where, `${role} must see admin-only rows`).not.toHaveProperty('NOT');
    }
  });

  it('protects= the exclusion uses NOT, so the tab type filter survives', async () => {
    // fails_when= the gate is written as `type: { notIn }`, which would clobber
    // the `type` key the Leads tab already set - the tab would then leak every
    // other type (including the admin-only rows it just tried to exclude).
    const { service, client } = makeService();
    await service.list(makeActor('MANAGER'), { ...defaultQuery, typePrefix: 'lead' });

    const where = client.notification.findMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(where['type']).toEqual({ startsWith: 'lead' });
    expect(where['NOT']).toEqual(ADMIN_ONLY);
  });

  it('protects= the unread badge count carries the same gate as the list', async () => {
    // Otherwise the bell shows "2 unread" and the inbox shows nothing: the
    // badge counts rows the list refuses to serve.
    const { service, client } = makeService();
    await service.list(makeActor('MANAGER'), { ...defaultQuery });

    const countWheres = client.notification.count.mock.calls.map((c) => c[0].where);
    expect(countWheres).toContainEqual({ read: false, NOT: ADMIN_ONLY });
  });

  it('protects= an ENGINEER keeps the progress.* clamp AND the admin-only gate', async () => {
    const { service, client } = makeService();
    await service.list(makeActor('ENGINEER'), { ...defaultQuery });

    const where = client.notification.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      type: { startsWith: 'progress' },
      NOT: ADMIN_ONLY,
    });
  });
});
