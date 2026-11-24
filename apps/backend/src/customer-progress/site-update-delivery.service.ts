// Buyer-facing WhatsApp delivery for a site update (build-sequence step 8).
//
// WHY A SEPARATE SERVICE: the clip is already saved and is the record of truth.
// Delivery is a FOLLOW-UP that may fail for reasons the customer does not care
// about (no phone, window closed, no approved template, Meta refusing a codec).
// So every outcome - sent, skipped, failed - is recorded on a SiteUpdateDelivery
// row and none of them can fail the save. This mirrors the notifier posture the
// photo path already uses.
//
// WHAT IT SENDS IS DECIDED BY THREE THINGS, in this order:
//   1. Is there an approved template? Without one, outside the window Meta
//      refuses business-initiated messages with 131047, so the honest outcome is
//      SKIPPED_NO_TEMPLATE, not a silent drop and not a guaranteed failure.
//   2. Is the buyer's 24h service window open? Inside it, freeform media is
//      allowed and free. Outside it, only an approved TEMPLATE is accepted.
//   3. Is the clip an MP4? WhatsApp takes MP4/H.264 only. A WebM (or a clip
//      whose bytes are gone) still gets a message: its POSTER plus a link, so
//      the buyer learns about the update instead of the send being dropped.
//
// ONE MESSAGE PER BATCH, NOT PER ROW. A note saves one row per file with a
// shared batchId (step 1), so a per-row send would fire six templates at a buyer
// for one site visit. The row's unique (organizationId, batchId) makes that a
// database guarantee, not a convention.
import { Logger } from '@nestjs/common';

import { isServiceWindowOpen } from '@shadhil/api-types';

import type { OutboundService } from '../whatsapp/outbound.service';

import { marketingConsent, type ConsentReader, type MarketingConsent } from './site-update-consent';
import { greetingName, NEUTRAL_GREETING } from './site-update-greeting';
import { buildSiteUpdateLink, resolveAppOrigin } from './site-update-link';

/** Prisma's unique-constraint code, as P2002. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/** The approved VIDEO-header template, or '' when it is not configured yet. */
function VIDEO_TEMPLATE(): string {
  return process.env['WA_TEMPLATE_SITE_UPDATE_VIDEO'] ?? '';
}

/** The approved IMAGE-header template, or '' when it is not configured yet. */
function IMAGE_TEMPLATE(): string {
  return process.env['WA_TEMPLATE_SITE_UPDATE_IMAGE'] ?? '';
}

/** Why a delivery was not attempted, or how it ended. Mirrors the DB enum. */
export type DeliveryOutcome =
  | 'PENDING'
  | 'SENT'
  | 'SKIPPED_WINDOW'
  | 'SKIPPED_NO_TEMPLATE'
  | 'SKIPPED_NO_BUYER'
  /** The templates are approved as MARKETING and this buyer has no opt-in. */
  | 'SKIPPED_NO_CONSENT'
  /** The operator switched the WhatsApp leg off. Not a fault, and not a template gap. */
  | 'SKIPPED_DISABLED'
  | 'FAILED';

/** The one switch an operator has for the buyer-facing leg. */
export const SITE_UPDATE_WHATSAPP_ENV = 'SITE_UPDATE_WHATSAPP';

/**
 * Is the WhatsApp leg on? ON unless the operator says otherwise.
 *
 * DEFAULT ON, deliberately: a flag that defaults to off would silently stop
 * every buyer notification on a deployment that never set it, which is exactly
 * the kind of quiet behaviour change nobody notices until a client asks why the
 * updates stopped. `off`, `false` and `0` (any case) switch it off; an unset or
 * empty value leaves it on.
 *
 * Read per call, not at module load, so a test can flip it and so a restart is
 * the only thing needed to change the answer (the env is not watched).
 */
export function siteUpdateWhatsAppEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[SITE_UPDATE_WHATSAPP_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return !(raw === 'off' || raw === 'false' || raw === '0');
}

export interface DeliveryInput {
  organizationId: string;
  unitId: string;
  /**
   * How the villa is named in the message: `A-101 (plot 37)`, or just the door
   * number when the villa is not on the layout yet. ONE value, so the template
   * needs no plot slot (which could never be left empty) - see
   * `site-update-villa.ts`.
   */
  unitLabel: string;
  /** Shared by every row saved from one note; the delivery unit. */
  batchId: string;
  /** The newest row of the batch, already saved. */
  rowId: string;
  kind: 'PHOTO' | 'VIDEO';
  /** ISO; the note's capture time, so the message can stand on its own. */
  takenAt: string;
  stage: string | null;
  caption: string;
  /**
   * Does `caption` hold something the engineer actually WROTE?
   *
   * False when the server generated the placeholder caption
   * (`buildCaption` -> "Phase A November 2026"), which happens on every capture
   * where the note was left blank - the common case. A placeholder is a fine
   * TIMELINE title and a poor thing to send a buyer as "the note", so the
   * template's note slot says "Your site team has posted a new update." instead.
   *
   * Passing this explicitly rather than sending `caption: ''` keeps the row and
   * the message from having to agree on a sentinel.
   */
  hasNote: boolean;
  /**
   * The caller's RLS transaction. REQUIRED: both new tables are FORCE RLS with
   * staff-gated writes, so a bare client cannot insert the row at all.
   */
  tx: RlsClient;
}

/**
 * The slice of the caller's transaction this service uses. Narrow on purpose:
 * the timeline/mapper tx type carries the whole Prisma client, but this service
 * only needs three delegates.
 */
export type RlsClient = {
  siteUpdateDelivery: {
    create(a: unknown): Promise<unknown>;
    update(a: unknown): Promise<unknown>;
    findMany?(a: unknown): Promise<unknown[]>;
  };
  progressPhoto: { findUnique(a: unknown): Promise<unknown> };
  booking: { findFirst(a: unknown): Promise<unknown> };
  message: {
    create(a: unknown): Promise<{ id: string }>;
    findFirst(a: unknown): Promise<unknown>;
  };
};

/** Who the message goes to, as far as this service can tell. */
export type BuyerTarget =
  | {
      kind: 'lead';
      leadId: string;
      phone: string;
      /**
       * First name for the greeting slot, or the neutral fallback. A template
       * parameter can never be omitted, so this is always a non-empty string
       * ("Asha" or "there") - see site-update-greeting.ts.
       */
      greeting: string;
    }
  | { kind: 'none'; reason: string };

/** Everything the send needs from outside, so the decision is pure. */
export interface DeliveryContext {
  /**
   * The approved template for THIS media, or '' when none is configured. Two
   * names, because Meta fixes a template's header type at approval: a clip goes
   * through the VIDEO template, a poster through the IMAGE one.
   */
  templateName: string;
  /** The buyer's last inbound message time, if there ever was one. */
  lastInboundAt: Date | null;
  now: Date;
  target: BuyerTarget;
  /** True when the clip can go as a WhatsApp video (MP4 in storage). */
  clipIsMp4: boolean;
  /**
   * The buyer's MARKETING opt-in. The templates are approved as marketing, so
   * Meta requires opt-in for them - consulted on the TEMPLATE path only,
   * because a freeform reply inside the service window is not marketing.
   */
  marketingConsent: MarketingConsent;
}

export type DeliveryPlan =
  | { send: 'freeform'; media: 'video' | 'image' }
  | { send: 'template'; templateName: string; media: 'video' | 'image' }
  | { send: 'none'; outcome: DeliveryOutcome; reason: string };

/**
 * The whole decision, pure: what to send, or why nothing is sent. Kept out of
 * the service so every branch is testable without a DB, a network or a clock.
 */
export function planDelivery(ctx: DeliveryContext): DeliveryPlan {
  if (ctx.target.kind === 'none') {
    // Nobody to send to is a SKIP, not a failure: a villa with no booking yet is
    // the normal case, and marking it FAILED sends support after a phantom bug.
    return { send: 'none', outcome: 'SKIPPED_NO_BUYER', reason: ctx.target.reason };
  }
  // MP4 goes as a video; anything else (WebM, purged bytes) goes as its poster,
  // which is exactly why step 5 makes the poster mandatory for every clip.
  const media = ctx.clipIsMp4 ? 'video' : 'image';
  const windowOpen = isServiceWindowOpen(ctx.lastInboundAt, ctx.now);
  if (windowOpen) return { send: 'freeform', media };
  if (ctx.templateName.length === 0) {
    // Not a failure: the operator has not approved a template yet. Recorded so
    // the queue is visible, never retried in a loop.
    return {
      send: 'none',
      outcome: 'SKIPPED_NO_TEMPLATE',
      reason: 'no approved site-update template and the 24h window is closed',
    };
  }
  // MARKETING OPT-IN (2026-11-23). The templates were approved as marketing, so
  // sending without consent is exactly what erodes the sender's quality rating.
  // Inside the window this branch is never reached: that path is freeform.
  if (ctx.marketingConsent !== 'granted') {
    return {
      send: 'none',
      outcome: 'SKIPPED_NO_CONSENT',
      reason:
        ctx.marketingConsent === 'denied'
          ? 'the buyer opted out of marketing messages'
          : 'the buyer has no recorded marketing opt-in',
    };
  }
  return { send: 'template', templateName: ctx.templateName, media };
}

/**
 * The note slot in the template. Meta will not accept an empty parameter, and
 * an engineer's note is optional, so the slot carries a line that reads as one
 * when there is nothing to add - never an empty string, never "undefined".
 */
export function noteSlot(caption: string, hasNote = true): string {
  const note = caption.trim();
  if (!hasNote || note.length === 0) return 'Your site team has posted a new update.';
  return note;
}

/**
 * The body a buyer reads: villa, stage and date, the note, then the link to
 * their record. The link is inside the body on purpose - a buyer on a phone
 * that has never opened the portal is signed out, and `/login?next=` brings
 * them back to this exact update (see `site-update-link.ts`).
 *
 * No configured origin is not a reason to send a broken link: the message goes
 * out without one and the log names the missing variable.
 */
export function deliveryCaption(
  input: DeliveryInput,
  appOrigin: string | null,
  greeting = NEUTRAL_GREETING,
): string {
  const bits = [`villa ${input.unitLabel}`];
  if (input.stage !== null && input.stage.length > 0) bits.push(input.stage);
  bits.push(new Date(input.takenAt).toISOString().slice(0, 10));
  // The SAME opening as the template, so a buyer who gets one of each does not
  // see two different companies. "there" is the neutral fallback, never a
  // dropped greeting (a template slot cannot be omitted anyway).
  const head = `Hello ${greeting}, here is your latest site update for ${bits.join(' · ')}.`;
  // A GENERATED caption is not a note: every capture where the engineer typed
  // nothing has one ("Phase A November 2026"), and sending that as a sentence
  // reads like a machine. Same rule as the template's note slot.
  const note = noteSlot(input.caption, input.hasNote);
  const body = `${head}\n${note}`;
  if (appOrigin === null) return body;
  return `${body}\n${buildSiteUpdateLink(appOrigin, input.unitId, input.rowId)}`;
}

export interface SiteUpdateDeliveryDeps {
  /**
   * NO bare Prisma client here, on purpose (2026-11-23). Every write and read
   * runs on the RLS transaction the caller passes in as `input.tx`, which is
   * the only context allowed to touch this table. An unused `client` field
   * looked harmless but it (a) tripped the bare-prisma guardrail, which cannot
   * tell an unused capability from a real bypass, and (b) invited the next
   * caller to query outside RLS. Removed rather than allowlisted.
   */
  outbound: OutboundService | undefined;
  storage: { stat(key: string): Promise<{ size: number } | null> } | undefined;
  logger: Logger;
}

/**
 * Records and attempts ONE delivery per batch. Never throws: a caller persisting
 * a site update must be unable to fail because WhatsApp did.
 */
export class SiteUpdateDeliveryService {
  constructor(private readonly deps: SiteUpdateDeliveryDeps) {}

  /**
   * Write the delivery row (idempotent on the batch) and enqueue the send.
   *
   * THE WRITE RUNS IN THE CALLER'S RLS TRANSACTION. `SiteUpdateDelivery` is
   * FORCE ROW LEVEL SECURITY with staff-gated write arms, so the bare client has
   * no `app.user_id` and the insert is denied with 42501 (measured: every video
   * save recorded nothing until this was threaded through). The caller already
   * has the exact context - the engineer who saved the update - and passing the
   * tx also makes the row commit with it.
   */
  async recordAndSend(input: DeliveryInput): Promise<void> {
    try {
      const deliveryId = await this.reserve(input);
      if (deliveryId === null) return;
      await this.enqueue(input, deliveryId);
    } catch (err) {
      this.deps.logger.error(
        `[site-update-delivery] unit=${input.unitId} batch=${input.batchId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Insert PENDING. Returns false when this batch was already recorded.
   *
   * The unique (organizationId, batchId) is the real guarantee, not the
   * pre-check: six photos in one note can reach here concurrently, and a
   * find-then-insert would let two of them both decide they were first. So a
   * unique violation IS the "already recorded" answer.
   */
  private async reserve(input: DeliveryInput): Promise<string | null> {
    try {
      const created = await input.tx.siteUpdateDelivery.create({
        data: {
          organizationId: input.organizationId,
          batchId: input.batchId,
          unitId: input.unitId,
          status: 'PENDING',
        },
        // The id is what the worker needs to report the outcome back to. Without
        // it the row is written and then unreachable, which is the bug this
        // change fixes.
        select: { id: true },
      });
      return (created as { id: string }).id;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  /**
   * Decide and either enqueue the send or record why nothing was sent. The
   * decision needs the buyer's window (Chat) and the clip's container (Storage),
   * both of which may be unavailable in a given deployment, so each absence has
   * its own recorded outcome rather than a crash.
   */
  private async enqueue(input: DeliveryInput, deliveryId: string): Promise<void> {
    const client = input.tx;
    // THE KILL SWITCH, and the first thing checked (2026-11-23). It sits before
    // every other branch on purpose: with the leg switched off, a missing
    // outbox is not a failure to report, the buyer is not looked up, and no
    // consent read happens. The row keeps the fact that this batch was skipped
    // BY CHOICE, which is what makes it re-sendable later; dropping the row
    // instead would lose the update entirely.
    if (!siteUpdateWhatsAppEnabled()) {
      await this.settle(input, 'SKIPPED_DISABLED', {
        errorCode: 'SKIPPED_DISABLED',
        reason: `${SITE_UPDATE_WHATSAPP_ENV}=off: the buyer-facing site-update leg is switched off`,
      });
      return;
    }
    if (this.deps.outbound === undefined) {
      await this.settle(input, 'FAILED', { errorCode: 'NO_OUTBOUND_SERVICE' });
      return;
    }
    const target = await this.buyerFor(input);
    const row = (await client.progressPhoto.findUnique({
      where: { id: input.rowId },
      select: { key: true, posterKey: true, kind: true, mimeType: true },
    })) as {
      key: string | null;
      posterKey: string | null;
      kind: 'PHOTO' | 'VIDEO';
      mimeType: string;
    } | null;
    if (row === null) {
      await this.settle(input, 'FAILED', { errorCode: 'ROW_MISSING' });
      return;
    }
    // MP4 by RECORDED TYPE, and only if the bytes are still there: WhatsApp takes
    // MP4/H.264 and nothing else, and a purged clip must not be sent as one.
    const clipIsMp4 =
      row.kind === 'VIDEO' &&
      row.mimeType === 'video/mp4' &&
      row.key !== null &&
      (await this.exists(row.key));

    // The header type is fixed at approval, so the NAME depends on the media.
    const ctx: DeliveryContext = {
      templateName: clipIsMp4 ? VIDEO_TEMPLATE() : IMAGE_TEMPLATE(),
      lastInboundAt: target.kind === 'lead' ? await this.lastInbound(input, target.leadId) : null,
      now: new Date(),
      target,
      clipIsMp4,
      // Read unconditionally: one indexed lookup is cheaper than a branch that
      // someone later forgets to update.
      marketingConsent:
        target.kind === 'lead'
          ? await marketingConsent(input.tx as unknown as ConsentReader, target.leadId)
          : 'never-asked',
    };
    const plan = planDelivery(ctx);
    if (plan.send === 'none') {
      await this.settle(input, plan.outcome, { errorCode: plan.outcome, reason: plan.reason });
      return;
    }
    if (target.kind !== 'lead') return; // unreachable: planDelivery already refused

    const appOrigin = this.appOrigin();
    const body = deliveryCaption(
      input,
      appOrigin,
      target.kind === 'lead' ? target.greeting : NEUTRAL_GREETING,
    );
    // The message row makes the send part of the buyer's thread, exactly as
    // `sendWelcome` does, so a reply lands where staff can see it.
    const message = await client.message.create({
      data: {
        leadId: target.leadId,
        organizationId: input.organizationId,
        userId: null,
        direction: 'OUT',
        channel: 'WHATSAPP',
        kind: 'CUSTOMER',
        body,
      },
      select: { id: true },
    });

    const mediaKey = plan.media === 'video' ? row.key : row.posterKey;
    // THE TX, NOT THE BARE CLIENT (2026-11-24). `OutboundMessage` is FORCE RLS
    // with an insert arm that needs `app.user_id`, which Prisma sets only on the
    // caller's transaction. Without the override the insert ran on the injected
    // client and was denied with 42501 - measured in production: the Message row
    // and this PENDING row were written, nothing was queued, and every site
    // update since the feature landed said PENDING forever.
    try {
      await this.deps.outbound.enqueue(
        {
          messageId: message.id,
          organizationId: input.organizationId,
          leadId: target.leadId,
          // The link the worker uses to report the outcome. Without it the delivery
          // row stays PENDING forever and the staff row says "Sending to buyer…"
          // over an update the buyer received hours ago.
          siteUpdateDeliveryId: deliveryId,
          sendType: plan.send === 'template' ? 'TEMPLATE' : 'FREEFORM',
          freeformBody: body,
          ...(plan.send === 'template'
            ? {
                templateName: plan.templateName,
                // Body order is the approved template's order: {{1}} the greeting
                // name (or "there"), {{2}} the villa number, {{3}} the engineer's
                // note or a neutral line. 'photo' is the URL button's variable,
                // sent as its own component by OutboundService.
                templateVars: {
                  '1': target.kind === 'lead' ? target.greeting : NEUTRAL_GREETING,
                  '2': input.unitLabel,
                  '3': noteSlot(input.caption, input.hasNote),
                  photo: input.rowId,
                },
              }
            : {}),
          ...(mediaKey === null
            ? {}
            : {
                mediaKey,
                mediaType: plan.media === 'video' ? 'video/mp4' : 'image/jpeg',
                mediaFilename: plan.media === 'video' ? 'site-update.mp4' : 'site-update.jpg',
              }),
        },
        input.tx as unknown as Parameters<OutboundService['enqueue']>[1],
      );
    } catch (err) {
      // A row that could not be queued is FAILED, not PENDING. PENDING is a
      // promise to the staff screen ("Sending to buyer..."); nothing was sent and
      // nothing will be, so the row has to say so.
      const reason = err instanceof Error ? err.message : String(err);
      await this.settle(input, 'FAILED', { errorCode: 'ENQUEUE_FAILED', reason });
      this.deps.logger.error(
        `[site-update-delivery] enqueue failed for unit=${input.unitId} batch=${input.batchId}: ${reason}`,
      );
      return;
    }
    await this.settle(input, 'PENDING', {});
  }

  /** The buyer of a unit: the lead on its most recent booking, if any. */
  private async buyerFor(input: DeliveryInput): Promise<BuyerTarget> {
    const booking = (await input.tx.booking.findFirst({
      where: { unitId: input.unitId, organizationId: input.organizationId },
      orderBy: { createdAt: 'desc' },
      select: { lead: { select: { id: true, name: true, phoneE164: true, phone: true } } },
    })) as {
      lead: {
        id: string;
        name: string;
        phoneE164: string | null;
        phone: string | null;
      } | null;
    } | null;
    const lead = booking?.lead;
    if (lead === undefined || lead === null) {
      return { kind: 'none', reason: `no booking buyer for unit ${input.unitId}` };
    }
    const phone = lead.phoneE164 ?? lead.phone;
    if (phone === null || phone.length === 0) {
      return { kind: 'none', reason: `buyer lead ${lead.id} has no WhatsApp number` };
    }
    return { kind: 'lead', leadId: lead.id, phone, greeting: greetingName(lead.name) };
  }

  /** The web origin for the message link, or null when it is not configured. */
  private appOrigin(): string | null {
    try {
      return resolveAppOrigin(process.env);
    } catch (err) {
      this.deps.logger.warn(
        `[site-update-delivery] no link in the message: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private async lastInbound(input: DeliveryInput, leadId: string): Promise<Date | null> {
    const last = (await input.tx.message.findFirst({
      where: { leadId, direction: 'IN' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })) as { createdAt: Date } | null;
    return last?.createdAt ?? null;
  }

  private async exists(key: string): Promise<boolean> {
    if (this.deps.storage === undefined) return false;
    return (await this.deps.storage.stat(key)) !== null;
  }

  private async settle(
    input: DeliveryInput,
    status: DeliveryOutcome,
    extra: { errorCode?: string; reason?: string },
  ): Promise<void> {
    await input.tx.siteUpdateDelivery.update({
      where: {
        organizationId_batchId: { organizationId: input.organizationId, batchId: input.batchId },
      },
      data: {
        status,
        ...(extra.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
        ...(status === 'SENT' ? { sentAt: new Date() } : {}),
        attempts: { increment: 1 },
      },
    });
    if (extra.reason !== undefined) {
      this.deps.logger.log(
        `[site-update-delivery] unit=${input.unitId} batch=${input.batchId} ${status}: ${extra.reason}`,
      );
    }
  }
}
