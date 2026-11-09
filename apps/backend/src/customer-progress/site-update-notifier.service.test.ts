// SiteUpdateNotifier (2026-11-08).
//
// protects= recipients come from the SECURITY DEFINER helper (never from an
//           inline query the uploader could not run), the uploader is excluded,
//           every emit carries organizationId and unitId, and a failure is
//           logged rather than thrown;
// fails_when= the uploader gets their own ping, a notification is emitted with
//           no unit anchor (invisible under the inbox's project filter), one
//           bouncing recipient stops the rest, or a throw escapes the notifier;
// no_claim= the helper's own SQL is proven against Postgres by the RLS suites;
//           here the RLS transaction is stubbed.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('@shadhil/database', () => ({
  withRlsContext: vi.fn(async (_c: unknown, _ctx: unknown, cb: (t: unknown) => unknown) =>
    cb({ $queryRaw: mocks.queryRaw }),
  ),
}));

import {
  clampBody,
  SiteUpdateNotifier,
  SITE_UPDATE_NOTIFICATION_TYPE,
} from './site-update-notifier.service';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';

const notice = (over: Partial<Parameters<SiteUpdateNotifier['notifyNewPhoto']>[0]> = {}) => ({
  organizationId: ORG,
  projectId: 'proj-1',
  unitId: 'unit-1',
  unitNumber: 'B-101',
  photoId: 'photo-1',
  caption: 'Plinth poured, curing until Friday',
  uploaderId: 'engineer-1',
  uploaderName: 'Ravi',
  ...over,
});

function build(): { notifier: SiteUpdateNotifier; emit: typeof mocks.emit } {
  const notifications = { emit: mocks.emit } as never;
  const notifier = new SiteUpdateNotifier({ $client: {} } as never, notifications);
  return { notifier, emit: mocks.emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryRaw.mockResolvedValue([]);
  mocks.emit.mockResolvedValue({ id: 'n-1' });
});

describe('clampBody', () => {
  it('keeps a short body intact', () => {
    expect(clampBody('Ravi: Slab poured')).toBe('Ravi: Slab poured');
  });

  it('clamps a long body with an ellipsis at the cap', () => {
    const long = 'x'.repeat(200);
    const clamped = clampBody(long, 120);
    expect(clamped.length).toBeLessThanOrEqual(120);
    expect(clamped.endsWith('...')).toBe(true);
  });
});

describe('SiteUpdateNotifier.notifyNewPhoto', () => {
  it('protects= emits once per recipient from the helper, excluding the uploader', async () => {
    mocks.queryRaw.mockResolvedValue([{ id: 'lead-1' }, { id: 'manager-1' }, { id: 'engineer-1' }]);
    const { notifier, emit } = build();

    const sent = await notifier.notifyNewPhoto(notice());

    expect(sent).toBe(2);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map((c) => c[0])).toEqual(['lead-1', 'manager-1']);
  });

  it('protects= every emit carries organizationId and unitId, or the inbox swallows it', async () => {
    mocks.queryRaw.mockResolvedValue([{ id: 'lead-1' }]);
    const { notifier, emit } = build();

    await notifier.notifyNewPhoto(notice());

    expect(emit).toHaveBeenCalledWith(
      'lead-1',
      expect.objectContaining({
        type: SITE_UPDATE_NOTIFICATION_TYPE,
        title: 'New site photo on B-101',
        body: 'Ravi: Plinth poured, curing until Friday',
        organizationId: ORG,
        unitId: 'unit-1',
      }),
    );
    // A site photo has no lead; sending a leadId would file it against a buyer's
    // enquiry it has nothing to do with.
    expect(emit.mock.calls[0]?.[1]).not.toHaveProperty('leadId');
  });

  it('falls back to the bare caption when the uploader has no name', async () => {
    mocks.queryRaw.mockResolvedValue([{ id: 'lead-1' }]);
    const { notifier, emit } = build();

    await notifier.notifyNewPhoto(notice({ uploaderName: null }));

    expect(emit.mock.calls[0]?.[1]).toMatchObject({ body: 'Plinth poured, curing until Friday' });
  });

  it('fails_when= one bouncing recipient stops the rest', async () => {
    mocks.queryRaw.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    mocks.emit.mockRejectedValueOnce(new Error('recipient gone')).mockResolvedValueOnce({ id: 'n-2' });
    const { notifier, emit } = build();

    const sent = await notifier.notifyNewPhoto(notice());

    expect(emit).toHaveBeenCalledTimes(2);
    expect(sent).toBe(1);
  });

  it('fails_when= a throw escapes the notifier (it must never reject)', async () => {
    mocks.queryRaw.mockRejectedValue(new Error('helper missing'));
    const { notifier } = build();

    await expect(notifier.notifyNewPhoto(notice())).resolves.toBe(0);
  });

  it('does nothing when the project has no recipients', async () => {
    mocks.queryRaw.mockResolvedValue([]);
    const { notifier, emit } = build();

    await expect(notifier.notifyNewPhoto(notice())).resolves.toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('does nothing when the only recipient IS the uploader', async () => {
    mocks.queryRaw.mockResolvedValue([{ id: 'engineer-1' }]);
    const { notifier, emit } = build();

    await expect(notifier.notifyNewPhoto(notice())).resolves.toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });
});
