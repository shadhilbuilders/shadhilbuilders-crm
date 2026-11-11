// PortalNotifier (issue #8 slice 2, D8).
//
// protects= recipients come only from unit_customer_user_ids() under the
//           named service identity, the payload is exactly the spec's, and
//           NO failure (lookup or delivery) ever escapes.
// fails_when= the notifier queries sales tables itself, uses a different
//           identity, sends a different payload, rejects on failure, or
//           pushes when there is nobody to push to.
// no_claim= does NOT prove a push reaches a device, nor that the SQL helper
//           picks the right users (customer-portal-rls.test.ts owns that).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const withRlsContext = vi.fn();
vi.mock('@shadhil/database', () => ({
  withRlsContext: (...a: unknown[]) => withRlsContext(...a),
}));

import { PORTAL_NOTIFIER_USER_ID, PortalNotifier } from './portal-notifier.service';

const NOTICE = {
  organizationId: 'org-1',
  unitId: 'unit-9',
  unitNumber: 'A-9',
  photoId: 'photo-1',
  caption: 'Foundation October 2026',
};

describe('PortalNotifier', () => {
  const sendToUsers = vi.fn();
  let notifier: PortalNotifier;

  beforeEach(() => {
    withRlsContext.mockReset();
    sendToUsers.mockReset().mockResolvedValue(2);
    notifier = new PortalNotifier({ $client: {} } as never, { sendToUsers } as never);
  });

  it('looks recipients up as portal-notifier/CRON_SERVICE and pushes the spec payload', async () => {
    withRlsContext.mockImplementation(async (_c, ctx, cb) => {
      expect(ctx).toEqual({ userId: PORTAL_NOTIFIER_USER_ID, role: 'CRON_SERVICE', organizationId: 'org-1' });
      return cb({ $queryRaw: vi.fn(async () => [{ id: 'c1' }, { id: 'c2' }]) });
    });
    expect(await notifier.notifyNewPhoto(NOTICE)).toBe(2);
    expect(sendToUsers).toHaveBeenCalledWith(
      'org-1',
      ['c1', 'c2'],
      {
        title: 'New photos for A-9',
        body: 'Foundation October 2026',
        url: '/portal?photo=photo-1',
        tag: 'progress-unit-9',
      },
      'CUSTOMER',
    );
  });

  it('does not push when no customer is entitled to the unit', async () => {
    withRlsContext.mockImplementation(async (_c, _x, cb) => cb({ $queryRaw: vi.fn(async () => []) }));
    expect(await notifier.notifyNewPhoto(NOTICE)).toBe(0);
    expect(sendToUsers).not.toHaveBeenCalled();
  });

  it('swallows a lookup failure (never rejects)', async () => {
    withRlsContext.mockRejectedValue(new Error('db down'));
    await expect(notifier.notifyNewPhoto(NOTICE)).resolves.toBe(0);
    expect(sendToUsers).not.toHaveBeenCalled();
  });

  it('swallows a delivery failure (never rejects)', async () => {
    withRlsContext.mockImplementation(async (_c, _x, cb) => cb({ $queryRaw: vi.fn(async () => [{ id: 'c1' }]) }));
    sendToUsers.mockRejectedValue(new Error('push 500'));
    await expect(notifier.notifyNewPhoto(NOTICE)).resolves.toBe(0);
  });
});
