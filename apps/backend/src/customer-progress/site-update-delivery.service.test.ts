// Site update WhatsApp delivery (build-sequence step 8).
//
// protects= one message per BATCH (not per row), the 24h window decides freeform
// vs template, no approved template is recorded as SKIPPED_NO_TEMPLATE rather
// than attempted and failed, a non-MP4 clip still reaches the buyer as its
// poster, a buyer with no booking or no phone is recorded as FAILED with the
// reason, and none of it can throw into the save.
// fails_when= six photos in one note produce six sends, a closed window with no
// template produces a doomed Meta call, a WebM is sent as a video, or a delivery
// failure surfaces to the engineer who saved the update.
import { describe, expect, it, vi } from 'vitest';

import {
  deliveryCaption,
  planDelivery,
  SITE_UPDATE_WHATSAPP_ENV,
  SiteUpdateDeliveryService,
  siteUpdateWhatsAppEnabled,
  type DeliveryContext,
  type DeliveryInput,
} from './site-update-delivery.service';

// RELATIVE TO THE RUN, not to a fixed calendar day (2026-11-24). The service
// reads the real clock to decide whether the buyer's 24h window is open, so
// pinning these to a date makes the whole file turn red the moment that date's
// window closes - which is what happened at 09:00Z on 2026-11-24, with no code
// change behind it. The expected message bodies take the date from NOW, so they
// keep asserting that the capture date is in the text.
const NOW = new Date();
const WARM = new Date(NOW.getTime() - 60 * 60 * 1000); // an hour ago: window open
const COLD = new Date(NOW.getTime() - 4 * 24 * 60 * 60 * 1000); // days ago: window closed

const ctx = (over: Partial<DeliveryContext> = {}): DeliveryContext => ({
  templateName: 'shadhil_site_update',
  lastInboundAt: WARM,
  now: NOW,
  target: { kind: 'lead', leadId: 'lead-1', phone: '919876543210', greeting: 'Asha' },
  clipIsMp4: true,
  marketingConsent: 'granted',
  ...over,
});

describe('planDelivery', () => {
  it('sends freeform media inside the 24h window', () => {
    expect(planDelivery(ctx())).toEqual({ send: 'freeform', media: 'video' });
  });

  it('uses the approved template outside the window', () => {
    expect(planDelivery(ctx({ lastInboundAt: COLD }))).toEqual({
      send: 'template',
      templateName: 'shadhil_site_update',
      media: 'video',
    });
  });

  it('records SKIPPED_NO_TEMPLATE outside the window, instead of a doomed send', () => {
    const plan = planDelivery(ctx({ lastInboundAt: COLD, templateName: '' }));
    expect(plan).toMatchObject({ send: 'none', outcome: 'SKIPPED_NO_TEMPLATE' });
  });

  it('sends a non-MP4 clip as its poster, not as a video Meta will refuse', () => {
    expect(planDelivery(ctx({ clipIsMp4: false }))).toEqual({ send: 'freeform', media: 'image' });
    expect(planDelivery(ctx({ clipIsMp4: false, lastInboundAt: COLD }))).toMatchObject({
      send: 'template',
      media: 'image',
    });
  });

  it('skips, rather than fails, when there is no buyer to send to', () => {
    // A villa with no booking is normal, not a broken integration.
    const plan = planDelivery(ctx({ target: { kind: 'none', reason: 'no booking buyer' } }));
    expect(plan).toMatchObject({ send: 'none', outcome: 'SKIPPED_NO_BUYER' });
  });
});

describe('deliveryCaption', () => {
  const input: DeliveryInput = {
    organizationId: 'org-1',
    unitId: 'unit-1',
    unitLabel: 'A-101 (plot 37)',
    batchId: 'b1',
    rowId: 'row-1',
    kind: 'VIDEO',
    takenAt: NOW.toISOString(),
    stage: 'STRUCTURE',
    caption: 'Plinth poured',
    hasNote: true,
    tx: {} as DeliveryInput['tx'],
  };

  it('greets by first name, then names the villa, the stage and the date', () => {
    expect(deliveryCaption(input, null, 'Asha')).toBe(
      `Hello Asha, here is your latest site update for villa A-101 (plot 37) · STRUCTURE · ${NOW.toISOString().slice(0, 10)}.\nPlinth poured`,
    );
  });

  it('uses the neutral greeting when no usable name exists', () => {
    expect(deliveryCaption(input, null, 'there')).toContain('Hello there,');
  });

  it('says a neutral line when the engineer wrote no note, never the generated caption', () => {
    // Every capture with a blank note stores a GENERATED caption ("Phase A
    // November 2026"). Sending that as a sentence reads like a machine, so the
    // slot says one plain line instead.
    expect(
      deliveryCaption(
        { ...input, stage: null, caption: 'Phase A November 2026', hasNote: false },
        null,
        'Asha',
      ),
    ).toBe(
      `Hello Asha, here is your latest site update for villa A-101 (plot 37) · ${NOW.toISOString().slice(0, 10)}.\nYour site team has posted a new update.`,
    );
  });

  it('drops the stage when it was not recorded', () => {
    expect(deliveryCaption({ ...input, stage: null }, null, 'Asha')).not.toContain('STRUCTURE');
  });

  it('appends the link to the buyer record, which survives a signed-out buyer', () => {
    const body = deliveryCaption(input, 'https://crm.example.com', 'Asha');
    expect(body.endsWith('https://crm.example.com/portal?unit=unit-1&photo=row-1')).toBe(true);
  });
});

// ── service ────────────────────────────────────────────────────────────────
function harness(
  over: {
    row?: unknown;
    booking?: unknown;
    lastInbound?: Date | null;
    /** The newest MARKETING consent row, or null/undefined for none. */
    consent?: { granted: boolean } | null;
  } = {},
) {
  const created: unknown[] = [];
  const client = {
    siteUpdateDelivery: {
      findUnique: vi.fn(async () => null),
      // Emulates the unique (organizationId, batchId) the DB enforces: a second
      // insert for the same batch is a P2002, which is the "already recorded"
      // answer the service relies on.
      create: vi.fn(async (args: { data: { batchId: string } }) => {
        if (
          created.some(
            (c) => (c as { data: { batchId: string } }).data.batchId === args.data.batchId,
          )
        ) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        created.push(args);
        // Prisma returns the selected column; the service needs the id to link
        // the outbox row back to this delivery.
        return { id: `sud-${created.length}` };
      }),
      update: vi.fn(async () => ({})),
    },
    progressPhoto: {
      findUnique: vi.fn(async () =>
        over.row === undefined
          ? {
              key: 'org/u/clip.mp4',
              posterKey: 'org/u/poster.jpg',
              kind: 'VIDEO',
              mimeType: 'video/mp4',
            }
          : over.row,
      ),
    },
    booking: {
      findFirst: vi.fn(async () =>
        over.booking === undefined
          ? { lead: { id: 'lead-1', name: 'Asha Nair', phoneE164: '919876543210', phone: null } }
          : over.booking,
      ),
    },
    consent: {
      // Newest-first ledger read. `null` (not undefined) is Prisma's "no row",
      // and the reader distinguishes that from a row saying granted=false.
      // Defaults to an opt-in so the pre-existing tests keep testing what they
      // were written for; the consent cases below override it.
      findFirst: vi.fn(async () => {
        if (over.consent === undefined) return { granted: true } as never;
        return over.consent as never;
      }),
    },
    message: {
      create: vi.fn(async () => ({ id: 'msg-1' })),
      findFirst: vi.fn(async () =>
        over.lastInbound === undefined
          ? { createdAt: WARM }
          : over.lastInbound === null
            ? null
            : { createdAt: over.lastInbound },
      ),
    },
  };
  const enqueue = vi.fn(async () => ({}));
  const stat = vi.fn(async () => ({ size: 1000 }));
  const service = new SiteUpdateDeliveryService({
    outbound: { enqueue } as never,
    storage: { stat } as never,
    logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
  });
  return { service, client, enqueue, created, tx: client as unknown as DeliveryInput['tx'] };
}

const input: DeliveryInput = {
  organizationId: 'org-1',
  unitId: 'unit-1',
  unitLabel: 'A-101 (plot 37)',
  batchId: 'batch-1',
  rowId: 'row-1',
  kind: 'VIDEO',
  takenAt: NOW.toISOString(),
  stage: 'STRUCTURE',
  caption: 'Plinth poured',
  hasNote: true,
  // Overwritten per test with the harness's tx; the service must use THAT one.
  tx: {} as DeliveryInput['tx'],
};

describe('SiteUpdateDeliveryService', () => {
  it('sends ONE message per batch, even when the batch has several rows', async () => {
    const h = harness();
    await h.service.recordAndSend({ ...input, tx: h.tx });
    await h.service.recordAndSend({ ...input, rowId: 'row-2', kind: 'PHOTO', tx: h.tx });
    expect(h.client.message.create).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not re-record a batch that already has a delivery row', async () => {
    const h = harness();
    await h.service.recordAndSend({ ...input, tx: h.tx });
    await h.service.recordAndSend({ ...input, tx: h.tx });
    expect(h.client.siteUpdateDelivery.create).toHaveBeenCalledTimes(2);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('carries the clip to Meta as video/mp4 inside the window', async () => {
    const h = harness();
    await h.service.recordAndSend({ ...input, tx: h.tx });
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sendType: 'FREEFORM',
        mediaKey: 'org/u/clip.mp4',
        mediaType: 'video/mp4',
      }),
      h.tx,
    );
  });

  it('sends the POSTER when the clip is not an MP4 Meta will take', async () => {
    const h = harness({
      row: {
        key: 'org/u/clip.webm',
        posterKey: 'org/u/poster.jpg',
        kind: 'VIDEO',
        mimeType: 'video/webm',
      },
    });
    // A .webm key still stats fine; what matters is that the plan then picks the
    // poster. The key's extension is a proxy for "MP4 only" here - the real
    // check is Meta accepting the bytes, and a WebM is refused (131026/131053).
    await h.service.recordAndSend({ ...input, tx: h.tx });
    const calls = h.enqueue.mock.calls as unknown as Array<
      [{ mediaKey: string; mediaType: string }]
    >;
    const arg = calls[0]![0];
    expect(arg.mediaKey).toBe('org/u/poster.jpg');
    expect(arg.mediaType).toBe('image/jpeg');
  });

  it('picks the VIDEO template for a clip outside the window', async () => {
    const h = harness({ lastInbound: COLD });
    const saved = {
      v: process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'],
      i: process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'],
    };
    process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'] = 'shadhil_site_update_video';
    process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'] = 'shadhil_site_update_image';
    try {
      await h.service.recordAndSend({ ...input, tx: h.tx });
    } finally {
      if (saved.v === undefined) delete process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'];
      else process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'] = saved.v;
      if (saved.i === undefined) delete process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'];
      else process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'] = saved.i;
    }
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sendType: 'TEMPLATE',
        templateName: 'shadhil_site_update_video',
      }),
      h.tx,
    );
  });

  it('picks the IMAGE template when the clip is not MP4, and names the button variable', async () => {
    const h = harness({
      row: {
        key: 'org/u/clip.webm',
        posterKey: 'org/u/poster.jpg',
        kind: 'VIDEO',
        mimeType: 'video/webm',
      },
      lastInbound: COLD,
    });
    const saved = {
      v: process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'],
      i: process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'],
    };
    process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'] = 'shadhil_site_update_video';
    process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'] = 'shadhil_site_update_image';
    try {
      await h.service.recordAndSend({ ...input, tx: h.tx });
    } finally {
      if (saved.v === undefined) delete process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'];
      else process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'] = saved.v;
      if (saved.i === undefined) delete process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'];
      else process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'] = saved.i;
    }
    const calls = h.enqueue.mock.calls as unknown as Array<
      [{ templateName: string; templateVars: Record<string, string>; mediaType: string }]
    >;
    expect(calls[0]![0]).toMatchObject({
      templateName: 'shadhil_site_update_image',
      mediaType: 'image/jpeg',
      // '1' is the body (villa number); 'photo' is the URL button's variable.
      // Body order: {{1}} greeting name, {{2}} villa, {{3}} the note slot.
      templateVars: {
        '1': 'Asha',
        '2': 'A-101 (plot 37)',
        '3': 'Plinth poured',
        photo: 'row-1',
      },
    });
  });

  it('refuses the marketing template when the buyer never opted in', async () => {
    // Approved as MARKETING, so an unconsented send is what damages the sender
    // number. Outside the window only the template path exists, so it must skip.
    const h = harness({ lastInbound: COLD, consent: null });
    const saved = {
      v: process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'],
      i: process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'],
    };
    process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'] = 'shadhil_site_update_video';
    process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'] = 'shadhil_site_update_image';
    try {
      await h.service.recordAndSend({ ...input, tx: h.tx });
    } finally {
      if (saved.v === undefined) delete process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'];
      else process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'] = saved.v;
      if (saved.i === undefined) delete process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'];
      else process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'] = saved.i;
    }
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.client.siteUpdateDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SKIPPED_NO_CONSENT' }),
      }),
    );
  });

  it('still sends freeform inside the window with no opt-in, because that is a reply', async () => {
    // A freeform message inside the 24h window is not a marketing template, so
    // requiring opt-in there would block the ordinary case for no reason.
    const h = harness({ consent: null });
    await h.service.recordAndSend({ ...input, tx: h.tx });
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sendType: 'FREEFORM' }), h.tx);
  });

  it('records SKIPPED_NO_TEMPLATE outside the window and sends nothing', async () => {
    const h = harness({ lastInbound: COLD });
    const savedVideo = process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'];
    const savedImage = process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'];
    delete process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'];
    delete process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'];
    try {
      await h.service.recordAndSend({ ...input, tx: h.tx });
    } finally {
      if (savedVideo !== undefined) process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'] = savedVideo;
      if (savedImage !== undefined) process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'] = savedImage;
    }
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.client.siteUpdateDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SKIPPED_NO_TEMPLATE' }) }),
    );
  });

  it('records SKIPPED_NO_BUYER with a reason when the unit has no buyer', async () => {
    const h = harness({ booking: null });
    await h.service.recordAndSend({ ...input, tx: h.tx });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.client.siteUpdateDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SKIPPED_NO_BUYER' }),
      }),
    );
  });

  it('never throws into the save, whatever fails', async () => {
    const h = harness();
    h.client.siteUpdateDelivery.create.mockRejectedValueOnce(new Error('db down'));
    await expect(h.service.recordAndSend(input)).resolves.toBeUndefined();
  });

  it('records SKIPPED_DISABLED and touches nothing when the switch is off', async () => {
    // The kill switch, and the point of it: with SITE_UPDATE_WHATSAPP=off the
    // update is still saved (the row exists, so it can be re-sent later), but no
    // buyer is looked up, no consent is read, no message is created and the
    // outbox is never touched. A switched-off deployment must not look broken.
    const h = harness();
    const saved = process.env[SITE_UPDATE_WHATSAPP_ENV];
    process.env[SITE_UPDATE_WHATSAPP_ENV] = 'off';
    try {
      await h.service.recordAndSend({ ...input, tx: h.tx });
    } finally {
      if (saved === undefined) delete process.env[SITE_UPDATE_WHATSAPP_ENV];
      else process.env[SITE_UPDATE_WHATSAPP_ENV] = saved;
    }
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.client.booking.findFirst).not.toHaveBeenCalled();
    expect(h.client.consent.findFirst).not.toHaveBeenCalled();
    expect(h.client.message.create).not.toHaveBeenCalled();
    expect(h.client.siteUpdateDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SKIPPED_DISABLED' }),
      }),
    );
  });

  it('leaves the leg ON when the switch is unset or empty', async () => {
    // The default that keeps a deployment which never set the variable working.
    for (const value of [undefined, '', '  ', 'on', 'true', '1']) {
      const env: Record<string, string | undefined> = {};
      if (value !== undefined) env[SITE_UPDATE_WHATSAPP_ENV] = value;
      expect(siteUpdateWhatsAppEnabled(env)).toBe(true);
    }
    for (const value of ['off', 'OFF', ' off ', 'false', '0']) {
      expect(siteUpdateWhatsAppEnabled({ [SITE_UPDATE_WHATSAPP_ENV]: value })).toBe(false);
    }
  });

  it("sends a photo's own bytes, not the poster column only video rows fill", async () => {
    // MEASURED (2026-11-24 10:16:58): a photo went out under the video mapping,
    // mediaKey came back null, the image header was dropped, and Meta answered
    // 132012 "header: Format mismatch, expected IMAGE, received UNKNOWN". The
    // poster column is empty on every PHOTO row, so that is the whole send.
    const h = harness({
      row: { key: 'org/u/photo.jpg', posterKey: null, kind: 'PHOTO', mimeType: 'image/jpeg' },
    });
    await h.service.recordAndSend({ ...input, kind: 'PHOTO', tx: h.tx });
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ mediaKey: 'org/u/photo.jpg', mediaType: 'image/jpeg' }),
      h.tx,
    );
  });

  it("queues on the caller's transaction, so the outbound insert passes its policy", async () => {
    // MEASURED IN PRODUCTION (2026-11-24): without the tx the insert ran on the
    // bare client, got `42501 new row violates row-level security policy for
    // table "OutboundMessage"`, and every site update recorded PENDING while
    // nothing was queued. The Message row and the delivery row both looked fine.
    const h = harness();
    await h.service.recordAndSend({ ...input, tx: h.tx });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    const calls = h.enqueue.mock.calls as unknown as Array<[unknown, unknown]>;
    expect(calls[0]?.[1]).toBe(h.tx);
  });

  it('records FAILED, not PENDING, when the outbox refuses the row', async () => {
    const h = harness();
    h.enqueue.mockRejectedValueOnce(
      new Error('new row violates row-level security policy for table "OutboundMessage"'),
    );
    await h.service.recordAndSend({ ...input, tx: h.tx });

    const updates = h.client.siteUpdateDelivery.update.mock.calls as unknown as Array<
      [{ data: { status: string; errorCode?: string } }]
    >;
    const settled = updates.map((call) => call[0].data);
    expect(settled.at(-1)).toMatchObject({ status: 'FAILED', errorCode: 'ENQUEUE_FAILED' });
    // PENDING is a promise to the staff screen. Nothing was queued, so it must not
    // be the last word.
    expect(settled.some((data) => data.status === 'PENDING')).toBe(false);
  });

  it('hands the delivery id to the outbox, so the worker can report the outcome', async () => {
    // THE BUG (2026-11-23): the row was written, the message was queued, and
    // nothing linked the two, so every delivery read PENDING forever. The id is
    // the only thread back from the worker to the row it reports on.
    const h = harness();
    await h.service.recordAndSend({ ...input, tx: h.tx });
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ siteUpdateDeliveryId: 'sud-1' }),
      h.tx,
    );
  });
});
