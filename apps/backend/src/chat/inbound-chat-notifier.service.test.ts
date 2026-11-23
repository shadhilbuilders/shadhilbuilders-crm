// Inbound chat notifications - who hears about a customer message, and how
// often.
//
// The bug being prevented: an inbound WhatsApp message created the Message row
// and nothing else, so only someone already looking at that lead ever saw it.
// The two failure modes this pins are (a) forgetting the co-owner or notifying
// the same person twice, and (b) turning a chatty customer into a push storm.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationsService } from '../notifications/notifications.service';

const TX = {
  current: {
    notification: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
      update: vi.fn(async (args: unknown) => args),
    },
  },
};

vi.mock('@shadhil/database', () => ({
  withRlsContext: vi.fn(
    async (_client: unknown, _ctx: unknown, callback: (tx: unknown) => unknown) =>
      callback(TX.current),
  ),
}));

import {
  inboundPreview,
  InboundChatNotifierService,
  INBOUND_CHAT_NOTIFICATION_TYPE,
} from './inbound-chat-notifier.service';

function makeService() {
  const emit = vi.fn(async () => ({ id: 'n1' }));
  const svc = new InboundChatNotifierService(
    { $client: {} } as never,
    {
      emit,
    } as unknown as NotificationsService,
  );
  return { svc, emit };
}

const base = {
  organizationId: 'org-1',
  projectId: 'proj-1',
  leadId: 'lead-1',
  leadName: 'Priya Sharma',
  body: 'Is the villa still available?',
};

beforeEach(() => {
  vi.clearAllMocks();
  TX.current = {
    notification: {
      findFirst: vi.fn(async () => null),
      update: vi.fn(async (args: unknown) => args),
    },
  };
});

describe('InboundChatNotifierService.notifyInbound', () => {
  it('notifies the owner and the co-owner', async () => {
    const { svc, emit } = makeService();
    await svc.notifyInbound({ ...base, recipientSubs: ['owner-1', 'co-1'] });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({
        type: INBOUND_CHAT_NOTIFICATION_TYPE,
        title: 'New message from Priya Sharma',
        body: 'Is the villa still available?',
        leadId: 'lead-1',
        projectId: 'proj-1',
        organizationId: 'org-1',
      }),
    );
    expect(emit).toHaveBeenCalledWith('co-1', expect.objectContaining({ leadId: 'lead-1' }));
  });

  it('notifies one person once when owner and co-owner are the same', async () => {
    const { svc, emit } = makeService();
    await svc.notifyInbound({ ...base, recipientSubs: ['owner-1', 'owner-1'] });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('notifies only the owner when there is no co-owner', async () => {
    const { svc, emit } = makeService();
    await svc.notifyInbound({ ...base, recipientSubs: ['owner-1', null] });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('owner-1', expect.anything());
  });

  it('ignores blank ids instead of emitting to nobody', async () => {
    const { svc, emit } = makeService();
    await svc.notifyInbound({ ...base, recipientSubs: ['', '   ', undefined] });
    expect(emit).not.toHaveBeenCalled();
  });

  it('folds a second message into the unread row instead of a second push', async () => {
    // The customer sent four messages in a minute. One row, newest text, no
    // storm of pushes: the recipient is told something arrived, not how many
    // times their phone buzzed.
    const { svc, emit } = makeService();
    TX.current.notification.findFirst = vi.fn(async () => ({ id: 'notif-1' }));
    const update = vi.fn(async (args: unknown) => args);
    TX.current.notification.update = update;

    await svc.notifyInbound({ ...base, recipientSubs: ['owner-1'], body: 'and parking?' });

    expect(emit).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { body: string; createdAt: Date };
    };
    expect(arg.where.id).toBe('notif-1');
    expect(arg.data.body).toBe('and parking?');
    expect(arg.data.createdAt).toBeInstanceOf(Date);
  });

  it('emits again once the previous row has been read', async () => {
    const { svc, emit } = makeService();
    TX.current.notification.findFirst = vi.fn(async () => null);
    await svc.notifyInbound({ ...base, recipientSubs: ['owner-1'] });
    expect(emit).toHaveBeenCalledTimes(1);
    // The unread-only filter is what makes this true; assert it is applied.
    const firstCall = TX.current.notification.findFirst.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ];
    const where = firstCall[0].where;
    expect(where).toMatchObject({
      userId: 'owner-1',
      type: INBOUND_CHAT_NOTIFICATION_TYPE,
      leadId: 'lead-1',
      read: false,
    });
  });

  it('never throws, so a notification failure cannot fail the webhook', async () => {
    const svc = new InboundChatNotifierService(
      { $client: {} } as never,
      {
        emit: vi.fn(async () => {
          throw new Error('inbox down');
        }),
      } as unknown as NotificationsService,
    );
    await expect(
      svc.notifyInbound({ ...base, recipientSubs: ['owner-1'] }),
    ).resolves.toBeUndefined();
  });

  it('does nothing when the notifications service is not wired', async () => {
    const svc = new InboundChatNotifierService({ $client: {} } as never);
    await expect(
      svc.notifyInbound({ ...base, recipientSubs: ['owner-1'] }),
    ).resolves.toBeUndefined();
  });
});

describe('inboundPreview', () => {
  it('shows the text as written', () => {
    expect(inboundPreview({ body: '  Ready to visit on Sunday  ' })).toBe(
      'Ready to visit on Sunday',
    );
  });

  it('truncates long text with three dots, never a bare cut', () => {
    const long = 'a'.repeat(200);
    const out = inboundPreview({ body: long });
    expect(out).toHaveLength(120);
    expect(out.endsWith('...')).toBe(true);
  });

  it('says what the media was, instead of an empty notification', () => {
    // An image arrives with body '', which used to produce a notification with
    // a title and nothing under it.
    expect(inboundPreview({ body: '', mediaKind: 'image' })).toBe('Sent a photo');
    expect(inboundPreview({ body: '', mediaKind: 'video' })).toBe('Sent a video');
    expect(inboundPreview({ body: '', mediaKind: 'audio' })).toBe('Sent a voice note');
  });

  it('keeps a document filename, the only clue whether it matters', () => {
    expect(inboundPreview({ body: '', mediaKind: 'document', filename: 'plan.pdf' })).toBe(
      'Sent a document: plan.pdf',
    );
    expect(inboundPreview({ body: '', mediaKind: 'document' })).toBe('Sent a document');
  });

  it('falls back to the stored mime type when Meta sends no kind', () => {
    expect(inboundPreview({ body: '', mimeType: 'image/jpeg' })).toBe('Sent a photo');
    expect(inboundPreview({ body: '', mimeType: 'audio/ogg' })).toBe('Sent a voice note');
  });

  it('still says something when there is neither text nor media', () => {
    expect(inboundPreview({ body: '' })).toBe('Sent a message');
  });
});
