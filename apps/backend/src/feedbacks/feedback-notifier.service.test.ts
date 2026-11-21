// FeedbackNotifier (2026-11-21).
//
// protects= every live ADMIN and OWNER of the submitting org is emitted one
//           notification, each carrying organizationId (or the owner-only insert
//           policy writes nothing) and an org-level deep link to the triage page;
// fails_when= the submit reply waits on a notification, one bouncing recipient
//           stops the rest, a soft-deleted admin is notified, a throw escapes the
//           notifier, or the copy is unreadable in the bell popover;
// no_claim= the recipient query's real RLS behaviour is the User table's business
//           (it has no policies); the RLS transaction is stubbed here.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  orgFindUnique: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('@shadhil/database', () => ({
  withRlsContext: vi.fn(async (_c: unknown, _ctx: unknown, cb: (t: unknown) => unknown) =>
    cb({
      user: { findMany: mocks.userFindMany },
      organization: { findUnique: mocks.orgFindUnique },
    }),
  ),
}));

import {
  clampFeedbackBody,
  FeedbackNotifier,
  feedbackNotificationCopy,
  FEEDBACK_CREATED_NOTIFICATION_TYPE,
  FEEDBACK_NOTIFIER_USER_ID,
} from './feedback-notifier.service';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';

const notice = (
  over: Partial<Parameters<FeedbackNotifier['notifyNewFeedback']>[0]> = {},
): Parameters<FeedbackNotifier['notifyNewFeedback']>[0] => ({
  organizationId: ORG,
  feedbackId: 'fb-1',
  rating: 5,
  name: 'Priya',
  project: 'Metro Heights',
  message: 'Plot handover was smooth, thank you',
  ...over,
});

function build(withNotifier = true): {
  notifier: FeedbackNotifier;
  emit: typeof mocks.emit;
} {
  const notifications = { emit: mocks.emit } as never;
  const notifier = withNotifier
    ? new FeedbackNotifier({ $client: {} } as never, notifications)
    : new FeedbackNotifier({ $client: {} } as never);
  return { notifier, emit: mocks.emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'owner-1' }]);
  mocks.orgFindUnique.mockResolvedValue({ slug: 'shadhil-builders' });
  mocks.emit.mockResolvedValue({ id: 'n-1' });
});

describe('clampFeedbackBody', () => {
  it('keeps a short body intact', () => {
    expect(clampFeedbackBody('Great plots')).toBe('Great plots');
  });

  it('truncates a long body with a visible signal', () => {
    const long = 'x'.repeat(400);
    const clamped = clampFeedbackBody(long, 140);
    expect(clamped.length).toBeLessThanOrEqual(140);
    expect(clamped.endsWith('...')).toBe(true);
  });
});

describe('feedbackNotificationCopy', () => {
  it('leads with the rating so the bell is scannable', () => {
    expect(
      feedbackNotificationCopy({ rating: 3, name: 'Priya', project: null, message: null }),
    ).toEqual({ title: 'New 3/5 feedback', body: 'Priya' });
  });

  it('names an anonymous submitter rather than rendering an empty line', () => {
    expect(
      feedbackNotificationCopy({ rating: 1, name: null, project: null, message: null }).body,
    ).toBe('Anonymous');
    expect(
      feedbackNotificationCopy({ rating: 1, name: '   ', project: null, message: null }).body,
    ).toBe('Anonymous');
  });

  it('includes the project and the message when present', () => {
    expect(
      feedbackNotificationCopy({
        rating: 4,
        name: 'Ravi',
        project: 'Metro Heights',
        message: 'Good value',
      }).body,
    ).toBe('Ravi · Metro Heights: Good value');
  });
});

describe('FeedbackNotifier.notifyNewFeedback', () => {
  it('protects= emits once to every live ADMIN and OWNER in the org', async () => {
    mocks.userFindMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'owner-1' }]);
    const { notifier, emit } = build();

    const sent = await notifier.notifyNewFeedback(notice());

    expect(sent).toBe(2);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map((c) => c[0])).toEqual(['admin-1', 'owner-1']);
  });

  it('protects= the audience query targets ADMIN + OWNER and skips soft-deleted users', async () => {
    const { notifier } = build();
    await notifier.notifyNewFeedback(notice());
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG,
          role: { in: ['ADMIN', 'OWNER'] },
          deletedAt: null,
        }),
      }),
    );
  });

  it('protects= every emit carries organizationId and the org-scoped triage link', async () => {
    const { notifier, emit } = build();
    await notifier.notifyNewFeedback(notice());

    expect(emit).toHaveBeenCalledWith(
      'admin-1',
      expect.objectContaining({
        type: FEEDBACK_CREATED_NOTIFICATION_TYPE,
        organizationId: ORG,
        href: '/shadhil-builders/admin/feedback',
      }),
    );
  });

  it('omits the deep link when the org slug cannot be resolved', async () => {
    // Better no link than `/admin/feedback`, which has no route.
    mocks.orgFindUnique.mockResolvedValue(null);
    const { notifier, emit } = build();

    await notifier.notifyNewFeedback(notice());

    expect(emit.mock.calls[0]?.[1]).not.toHaveProperty('href');
  });

  it('fails_when= one bouncing recipient stops the rest', async () => {
    mocks.emit
      .mockRejectedValueOnce(new Error('recipient gone'))
      .mockResolvedValueOnce({ id: 'n-2' });
    const { notifier, emit } = build();

    const sent = await notifier.notifyNewFeedback(notice());

    expect(emit).toHaveBeenCalledTimes(2);
    expect(sent).toBe(1);
  });

  it('fails_when= a throw escapes the notifier (it must never reject)', async () => {
    mocks.userFindMany.mockRejectedValue(new Error('db down'));
    const { notifier } = build();
    await expect(notifier.notifyNewFeedback(notice())).resolves.toBe(0);
  });

  it('does nothing when the org has no admin-class user', async () => {
    mocks.userFindMany.mockResolvedValue([]);
    const { notifier, emit } = build();
    await expect(notifier.notifyNewFeedback(notice())).resolves.toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('no-ops when the notification dep is absent (test harness)', async () => {
    const { notifier, emit } = build(false);
    await expect(notifier.notifyNewFeedback(notice())).resolves.toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('protects= the recipient lookup runs under a service identity, not the submitter', async () => {
    // The public submit path is PUBLIC_API, which cannot read User rows. The
    // lookup has to happen under CRON_SERVICE or it returns nobody.
    const { withRlsContext } = await import('@shadhil/database');
    const { notifier } = build();
    await notifier.notifyNewFeedback(notice());

    expect(vi.mocked(withRlsContext)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: FEEDBACK_NOTIFIER_USER_ID, role: 'CRON_SERVICE' }),
      expect.any(Function),
    );
  });
});
