// Webhooks controller - inbound from WhatsApp (Meta) and FreJun (telephony).
//
// Routes are @Public() BY DESIGN (AR-8): these receive calls from
// Meta/FreJun servers, not authenticated users. Auth is the WhatsApp
// signature guard (HMAC-SHA256 of the raw body via WA_APP_SECRET)
// and the FreJun signature mechanism (TBD). The GET verify-handshake
// uses a shared token in the URL (hub.verify_token).
//
// T-E2b (2026-09-04): WhatsApp inbound handler - full implementation.
//
//   GET  /api/webhooks/whatsapp  - Meta verify-handshake (echo challenge)
//   POST /api/webhooks/whatsapp  - Inbound events
//     • Status updates (sent/delivered/read/failed) - update the
//       matching OutboundMessage by metaMessageId
//     • Inbound text messages from KNOWN leads - write a Message
//       row (channel=WHATSAPP, direction=INBOUND, body=Meta text)
//     • Inbound text messages from UNKNOWN numbers - upsert a
//       WhatsappUnknownContact row for telecaller follow-up. We
//       deliberately do NOT auto-create a Lead (per the T-E2b
//       product decision: lead creation is a manual telecaller
//       action, not automatic from WA inbound).
//
//   POST /api/webhooks/frejun - FreJun inbound (still stubbed)
//
// The handler runs as CRON_SERVICE (no RLS user context) because
// the sender is Meta/the system, not a staff user. CRON_SERVICE
// has full RLS bypass on WebhookEvent, WhatsappUnknownContact,
// and the targeted CRON_SERVICE bypass policies on Message and
// OutboundMessage for the relevant operations.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Optional,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { tryParsePhone } from '@shadhil/api-types';

import { Public } from '../auth/public.decorator';
import { prisma as barePrisma, withRlsContext } from '@shadhil/database';
import { listOrganizationIds } from '../common/cron-orgs';
import { STORAGE_PROVIDER } from '../storage/storage.tokens';
import type { StorageProvider } from '../storage/storage.provider';
import { InboundChatNotifierService } from '../chat/inbound-chat-notifier.service';
import { WhatsAppClient } from '../whatsapp/whatsapp.client';

import { WhatsappSignatureGuard } from './whatsapp-signature.guard';

// ─── Meta envelope shape (subset we use) ─────────────────────────────
// Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
// The full payload is deeply nested. We only care about:
//
//   body.object = "whatsapp_business_account"
//   body.entry[].changes[].field = "messages"
//   body.entry[].changes[].value {
//     metadata: { phone_number_id, display_phone_number },
//     contacts: [{ profile: { name }, wa_id }],
//     messages:  [{ from, id, timestamp, type, text: { body } }],
//     statuses:  [{ id, status, timestamp, recipient_id, errors? }],
//   }
//
// The controller is intentionally schema-loose: it does runtime
// narrowing via small guards, not Zod (which would inflate the
// dep surface for a webhook whose only consumer is Meta).

type MetaEnvelope = {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: Array<{
          from?: string;
          id?: string;
          timestamp?: string | number;
          type?: string;
          text?: { body?: string };
          // (image/video/audio/document/interactive/button/...) are
          // not yet supported in T-E2b - we accept them but ignore.
          [k: string]: unknown;
        }>;
        statuses?: Array<{
          id?: string;
          status?: string;
          timestamp?: string | number;
          recipient_id?: string;
          errors?: Array<{ code?: number; title?: string }>;
        }>;
      };
    }>;
  }>;
};

type ProcessingResult = {
  received: boolean;
  deduped: number;
  messagesCreated: number;
  statusesUpdated: number;
  unknownContactsUpserted: number;
  ignored: number;
  errors: string[];
};

@ApiTags('webhooks')
@Controller('webhooks')
@UseGuards(WhatsappSignatureGuard)
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    // MEDIA (2026-09-17, 2B): inbound media (image/doc/audio) - the client
    // downloads bytes from Meta, the storage provider persists them, and the
    // resulting Message row carries the mediaUrl for the chat pane.
    // @Optional so the DB-backed text-path test constructs the controller
    // without them (text handling doesn't touch these).
    @Optional()
    @Inject(WhatsAppClient)
    private readonly whatsapp?: WhatsAppClient,
    @Optional()
    @Inject(STORAGE_PROVIDER)
    private readonly storage?: StorageProvider,
    // 2026-11-23: inbound customer messages now alert the lead's owner and
    // co-owner (inbox + push). @Optional() so the DB-backed text-path test can
    // still construct the controller without the chat module.
    @Optional()
    @Inject(InboundChatNotifierService)
    private readonly chatNotifier?: InboundChatNotifierService,
  ) {}

  // ── GET handshake ─────────────────────────────────────────────────
  // Meta's verify-handshake: GET ?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y
  // The signature guard passes GETs through (no body to sign), and
  // this handler echoes the challenge only when the token matches.
  @Public()
  @Get('whatsapp')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    const expected = process.env['WA_WEBHOOK_VERIFY_TOKEN'];
    if (mode === 'subscribe' && expected && token === expected && challenge) {
      return challenge;
    }
    // Fail loudly so Meta retries and the operator sees the broken
    // config in the dashboard. Returning 403 would be more RESTful
    // but a thrown error surfaces the same code with a clearer
    // log line; either way Meta will retry.
    throw new Error(
      'WhatsApp webhook verification failed: hub.mode/hub.verify_token mismatch or WA_WEBHOOK_VERIFY_TOKEN unset',
    );
  }

  // ── POST inbound ──────────────────────────────────────────────────
  // Always 200 on success - Meta retries events with non-2xx
  // responses up to 7 days. Internal errors are caught and logged
  // but the response is still 200, so Meta doesn't keep hammering
  // a temporarily-failing handler.
  @Public()
  @Post('whatsapp')
  async whatsappInbound(@Body() body: MetaEnvelope): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      received: true,
      deduped: 0,
      messagesCreated: 0,
      statusesUpdated: 0,
      unknownContactsUpserted: 0,
      ignored: 0,
      errors: [],
    };

    if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
      // Not a WA event (e.g. test ping, wrong subscription). Ack so
      // Meta doesn't retry, log so we can investigate.
      this.logger.warn(`WhatsApp inbound: not a WA event (object=${body?.object})`);
      return result;
    }

    // Flatten the nested envelope. The handler iterates each
    // (message, status) event and processes it independently - a
    // failure in one event must not block the others.
    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages' || !change.value) continue;

        // Status updates first - they're cheap and independent of
        // any DB lookup.
        for (const status of change.value.statuses ?? []) {
          try {
            const updated = await this.handleStatusUpdate(status, change.value.metadata);
            if (updated) result.statusesUpdated += 1;
            else result.ignored += 1;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.error(`status update failed: ${msg}`);
            result.errors.push(`status: ${msg}`);
          }
        }

        // Inbound messages second - each is one webhook event.
        for (const message of change.value.messages ?? []) {
          try {
            const r = await this.handleInboundMessage(message);
            if (r === 'deduped') result.deduped += 1;
            else if (r === 'message') result.messagesCreated += 1;
            // T-WA-INBOX: an unknown number's inbound is now BOTH a triage
            // contact and a stored message, so it increments both counters.
            else if (r === 'unknown-contact-message') {
              result.messagesCreated += 1;
              result.unknownContactsUpserted += 1;
            } else if (r === 'unknown-contact') result.unknownContactsUpserted += 1;
            else result.ignored += 1;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.error(`inbound message failed: ${msg}`);
            result.errors.push(`message: ${msg}`);
          }
        }
      }
    }

    if (result.errors.length > 0) {
      this.logger.warn(
        `WhatsApp inbound: ${result.messagesCreated} msg, ${result.statusesUpdated} status, ${result.unknownContactsUpserted} unknown, ${result.errors.length} errors`,
      );
    }
    return result;
  }

  /**
   * Orgs to probe when resolving an inbound message or a status callback.
   * PUBLIC_ORG_ID comes first so a single-tenant deployment costs one query.
   *
   * T-WA-MULTITENANT (2026-11-19): both webhook paths used to run entirely
   * inside PUBLIC_ORG_ID's RLS context. The status UPDATE then matched nothing
   * for any other org (the outbox row sat at SENT while Meta had already
   * reported delivered) and an inbound reply from another org's lead was filed
   * as an unknown contact in the PUBLIC org. Meta tells us which number the
   * event came from, never which tenant, so the phone number is the only join
   * we have: probe each org's own RLS context and take the one that matches.
   */
  private async webhookOrgIds(): Promise<string[]> {
    const publicOrgId = process.env['PUBLIC_ORG_ID'] ?? '';
    let all: string[] = [];
    try {
      all = await listOrganizationIds(barePrisma);
    } catch (err) {
      // Never fail the webhook on this: Meta retries for days and a retry storm
      // helps nobody. Falling back to PUBLIC_ORG_ID keeps single-tenant working.
      this.logger.error(
        `webhook: could not list organizations, falling back to PUBLIC_ORG_ID: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (publicOrgId.length === 0) return all;
    return [publicOrgId, ...all.filter((id) => id !== publicOrgId)];
  }

  // ── Status update handler ─────────────────────────────────────────
  // Map Meta's `status` string to our OutboundStatus enum, then
  // find the matching OutboundMessage by metaMessageId (the wamid
  // Meta gave us when we sent the message) and update its status.
  // Returns true if updated, false if not found (caller increments
  // `ignored`).
  private async handleStatusUpdate(
    status: { id?: string; status?: string; recipient_id?: string },
    metadata: { phone_number_id?: string } | undefined,
  ): Promise<boolean> {
    if (!status.id || !status.status) return false;
    const ourStatus = mapMetaStatus(status.status);
    if (ourStatus === null) {
      // Unknown Meta status (e.g. a new one they add). Log and ignore.
      this.logger.warn(`Unknown Meta status: ${status.status} (wamid=${status.id})`);
      return false;
    }

    // Try each org until one owns the outbox row. The update carries no org
    // predicate, so RLS decides what it can see - one context per org is the
    // only way to reach rows outside PUBLIC_ORG_ID.
    const orgIds = await this.webhookOrgIds();
    for (const organizationId of orgIds) {
      const updated = await withRlsContext(
        barePrisma,
        {
          userId: 'CRON_SERVICE',
          role: 'CRON_SERVICE',
          organizationId,
        },
        async (tx) => {
          return await tx.$executeRawUnsafe(
            `UPDATE "OutboundMessage" SET status = $1::"OutboundStatus" WHERE "wamid" = $2`,
            ourStatus,
            status.id,
          );
        },
      );
      if (updated > 0) return true;
    }

    // Could be: (a) a status for a message we never sent (test event, recovery
    // from a different system), (b) a status arriving after the OutboundMessage
    // row was deleted, or (c) a send from a different database entirely (a dev
    // box pointed at the same Meta app). Log so we can spot patterns.
    this.logger.debug(
      `No OutboundMessage matches wamid=${status.id} (status=${status.status}, phone_number_id=${
        metadata?.phone_number_id ?? '?'
      }) across ${orgIds.length} org(s)`,
    );
    return false;
  }

  // ── Inbound message handler ───────────────────────────────────────
  // Returns one of: 'message' (known lead, Message row created),
  // 'unknown-contact' (unknown number, WhatsappUnknownContact row
  // upserted), 'deduped' (already processed), 'ignored' (e.g. not a
  // text/message-supported media type, or no message id).
  private async handleInboundMessage(message: {
    from?: string;
    id?: string;
    timestamp?: string | number;
    type?: string;
    image?: { id?: string; mime_type?: string };
    video?: { id?: string; mime_type?: string };
    audio?: { id?: string; mime_type?: string };
    document?: { id?: string; mime_type?: string; filename?: string };
    text?: { body?: string };
    [k: string]: unknown;
  }): Promise<'message' | 'unknown-contact' | 'unknown-contact-message' | 'deduped' | 'ignored'> {
    if (!message.id || !message.from) return 'ignored';
    const externalId = message.id;
    // One parser for every inbound number. Meta sends international digits, so
    // this reads them as E.164 and never guesses a country. A value that cannot
    // be parsed is still answered 200 to Meta (a non-200 makes it retry
    // forever), but it is recorded as an unknown contact rather than dropped:
    // a counter nobody reads is still a lost customer.
    const inbound = tryParsePhone({ source: 'e164', digits: String(message.from) });
    if (!inbound.ok) {
      this.logger.error(
        `WhatsApp inbound: unparseable from=${String(message.from)} reason=${inbound.reason}`,
      );
      return 'ignored';
    }
    const phoneE164 = inbound.value.e164;

    const isText = message.type === 'text' && typeof message.text?.body === 'string';
    // MEDIA (2B): supported inbound media types carry a Meta media id.
    const mediaInfo = isText ? null : extractMedia(message);

    // T-WA-MULTITENANT (2026-11-19): resolve the owning org BEFORE writing
    // anything. The handler used to stamp every row with PUBLIC_ORG_ID, which
    // buried replies from any other org's lead as unknown contacts in the
    // public org. An unknown number still falls back to PUBLIC_ORG_ID: Meta
    // never tells us which tenant an unknown sender belongs to, and inventing
    // one would be worse than the fallback.
    //
    // T-PHONE-PER-ORG (2026-11-19): Lead.phoneE164 is unique per org now, not
    // globally, so the phone no longer identifies the tenant by itself - this
    // loop is what does. If the same number is a lead in two orgs the inbound
    // is genuinely ambiguous (Meta sends no tenant hint), so we take the first
    // match and log both, because silence here would look like a routing bug.
    const orgIds = await this.webhookOrgIds();
    let owningOrgId = process.env['PUBLIC_ORG_ID'] ?? '';
    let lead: {
      id: string;
      name: string | null;
      ownerId: string;
      coOwnerId: string | null;
      projectId: string;
    } | null = null;
    const matchedOrgIds: string[] = [];
    for (const candidateOrgId of orgIds) {
      const hit = await withRlsContext(
        barePrisma,
        {
          userId: 'CRON_SERVICE',
          role: 'CRON_SERVICE',
          organizationId: candidateOrgId,
        },
        (tx) =>
          tx.lead.findFirst({
            where: { phoneE164, organizationId: candidateOrgId },
            // owner/co-owner are the two people this lead belongs to, and an
            // inbound message has to reach both of them.
            select: {
              id: true,
              name: true,
              ownerId: true,
              coOwnerId: true,
              projectId: true,
            },
          }),
      );
      if (hit !== null) {
        matchedOrgIds.push(candidateOrgId);
        if (lead === null) {
          lead = hit;
          owningOrgId = candidateOrgId;
        }
      }
    }
    if (matchedOrgIds.length > 1) {
      this.logger.warn(
        `[whatsapp] inbound from ${phoneE164} matches leads in ${matchedOrgIds.join(
          ', ',
        )} - routing to ${owningOrgId}. Same number, multiple tenants; pick manually if this is wrong.`,
      );
    }

    // Filled INSIDE the transaction, consumed after it commits: the
    // notification must describe a row that actually exists, and an emit for a
    // rolled-back insert would be a lie the recipient cannot check.
    let stored: { body: string; mediaType: string | null; filename: string | null } | null = null;
    const outcome = await withRlsContext(
      barePrisma,
      {
        userId: 'CRON_SERVICE',
        role: 'CRON_SERVICE',
        organizationId: owningOrgId,
      },
      async (tx) => {
        // 1) Dedup via WebhookEvent.externalId unique constraint.
        try {
          await tx.webhookEvent.create({
            data: {
              source: 'WHATSAPP',
              externalId,
              payload: message as object,
              organizationId: owningOrgId,
            },
          });
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'P2002') return 'deduped';
          throw e;
        }

        // 2) The lead lookup already ran above - it is what chose the org.
        if (lead) {
          // 3a) Known lead - create the Message row. Text OR media.
          // Use $executeRaw for consistency with the existing text path
          // (avoids the RLS interaction quirk on typed tx.message.create).
          // MEDIA (2026-09-18): store the provider-neutral mediaKey; mediaUrl
          // is left NULL for new rows and derived per request from the key
          // (storage/media-display.ts), so the storage provider is not baked
          // into the row.
          let mediaKey: string | null = null;
          let mediaType: string | null = null;
          let mediaFilename: string | null = null;
          if (mediaInfo !== null) {
            const stored = await this.downloadAndStoreInboundMedia(mediaInfo, owningOrgId);
            if (stored !== null) {
              mediaKey = stored.mediaKey;
              mediaType = stored.mediaType;
              mediaFilename = stored.filename;
            }
          }
          const body = isText ? message.text!.body! : '';
          const msgId = `wa_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          await tx.$executeRawUnsafe(
            `INSERT INTO "Message" (id, "organizationId", "leadId", "userId", direction, channel, body, "externalId", "mediaKey", "mediaType", "mediaFilename", "createdAt") VALUES ($1, $2, $3, NULL, 'IN', 'WHATSAPP', $4, $5, $6, $7, $8, NOW())`,
            msgId,
            owningOrgId,
            lead.id,
            body,
            externalId,
            mediaKey,
            mediaType,
            mediaFilename,
          );
          stored = { body, mediaType, filename: mediaFilename };
          return 'message';
        }

        // 3b) Unknown number - upsert WhatsappUnknownContact. We
        // deliberately do NOT auto-create a Lead (per the T-E2b
        // product decision: don't create Leads on unknown inbound).
        // MEDIA (2B): store a generic "(attachment)" body label so the
        // follow-up queue isn't empty for non-text contact messages.
        const ts = message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date();
        const body = isText
          ? message.text!.body!
          : mediaInfo !== null
            ? `📎 ${mediaInfo.type}`
            : '';
        // T-WA-INBOX (2026-09-25): store the message itself, not just counters.
        //
        // Before this, an unknown number's individual messages were DISCARDED -
        // the upsert only bumped lastMessageAt/messageCount and kept
        // firstMessageBody, so a manager could see "5 messages from this
        // number" and nothing else. The WhatsApp inbox needs the actual
        // conversation to read and reply to, so the inbound is persisted as a
        // real Message row (contactId thread; the migration made leadId
        // nullable and added the exactly-one-thread CHECK).
        //
        // The upsert is kept AS WELL: WhatsappUnknownContact.status is what the
        // existing triage queue (PENDING -> CONVERTED/SPAM) keys on, and
        // messageCount/lastMessageAt still drive that list's sorting. This is a
        // superset of the old behaviour, not a replacement.
        //
        // Media is stored the same way as the known-lead branch so the inbox
        // can render inbound attachments for unknown numbers too.
        const contact = await tx.whatsappUnknownContact.upsert({
          where: { phoneE164 },
          create: {
            phoneE164,
            firstMessageAt: ts,
            lastMessageAt: ts,
            firstMessageBody: body,
            // messageCount is NOT set here on purpose: the column defaults to
            // 1 (schema.prisma), which is exactly right for a contact created
            // by its first inbound. The update branch below increments it.
            // T-ORG: first sighting assigns the org (the column is the one
            // intentionally-nullable org column). Without this the contact
            // thread would be org-less and unreachable by every RLS policy
            // that compares organizationId to app.user_org_id.
            organizationId: owningOrgId,
          },
          update: {
            lastMessageAt: ts,
            messageCount: { increment: 1 },
          },
          select: { id: true },
        });

        // Media is stored with the same provider-neutral key + type + filename
        // shape the known-lead branch uses, so the inbox renders inbound
        // attachments for unknown numbers identically (images inline,
        // documents as a download link).
        let contactMediaKey: string | null = null;
        let contactMediaType: string | null = null;
        let contactMediaFilename: string | null = null;
        if (mediaInfo !== null) {
          const stored = await this.downloadAndStoreInboundMedia(mediaInfo, owningOrgId);
          if (stored !== null) {
            contactMediaKey = stored.mediaKey;
            contactMediaType = stored.mediaType;
            contactMediaFilename = stored.filename;
          }
        }
        // One placeholder per bound value: the column list has 12 columns, of
        // which userId is NULL and createdAt is NOW(), leaving 9 bound params.
        const contactMsgId = `wa_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await tx.$executeRawUnsafe(
          `INSERT INTO "Message" (id, "organizationId", "contactId", "userId", direction, channel, body, "externalId", "mediaKey", "mediaType", "mediaFilename", "createdAt") VALUES ($1, $2, $3, NULL, 'IN', 'WHATSAPP', $4, $5, $6, $7, $8, NOW())`,
          contactMsgId,
          owningOrgId,
          contact.id,
          body,
          externalId,
          contactMediaKey,
          contactMediaType,
          contactMediaFilename,
        );
        // A stored history row IS a created message. The old contract counted
        // it 0 because the message was thrown away; keeping that number would
        // under-report every inbound from a new number.
        return 'unknown-contact-message';
      },
    );

    // 4) The customer wrote to us. Tell the two people this lead belongs to
    //    (owner, co-owner) in the inbox and on their phones. Outside the
    //    transaction, best-effort: a notification failure must not turn a
    //    delivered message into a webhook error Meta will retry forever.
    // TS cannot see an assignment made inside the callback, so it believes
    // `stored` is still null; the cast states the type without inventing a
    // value. `stored` is only ever set on the branch that returns 'message'.
    const captured = stored as {
      body: string;
      mediaType: string | null;
      filename: string | null;
    } | null;
    if (outcome === 'message' && lead !== null && captured !== null) {
      const target = lead;
      await this.chatNotifier
        ?.notifyInbound({
          organizationId: owningOrgId,
          projectId: target.projectId,
          leadId: target.id,
          leadName: target.name,
          recipientSubs: [target.ownerId, target.coOwnerId],
          body: captured.body,
          // Meta's kind (image/video/audio/document) names the notification;
          // the stored mime type is only the fallback.
          mediaKind: mediaInfo?.type ?? null,
          mimeType: captured.mediaType,
          filename: captured.filename,
        })
        .catch(() => undefined);
    }

    return outcome;
  }

  /** Download an inbound media message from Meta + persist via storage.
   *  Returns the stored key + metadata, or null if download/storage failed
   *  (so the webhook still acks and doesn't retry a corrupt event).
   *
   *  Returns the provider-neutral KEY (not a display URL) - the caller stores
   *  it in Message.mediaKey and the display URL is derived per request by
   *  ChatService.displayMediaUrl() (storage/media-display.ts). */
  private async downloadAndStoreInboundMedia(
    media: NonNullable<ReturnType<typeof extractMedia>>,
    organizationId: string,
  ): Promise<{ mediaKey: string; mediaType: string; filename: string } | null> {
    if (this.whatsapp === undefined || this.storage === undefined) return null;
    try {
      const file = await this.whatsapp.downloadMedia(media.mediaId);
      if (file === null) {
        this.logger.warn(`[whatsapp] inbound media download failed id=${media.mediaId}`);
        return null;
      }
      const stored = await this.storage.save(file.buffer, {
        organizationId,
        mimeType: file.mimeType,
        filename: media.filename ?? file.filename,
      });
      return {
        mediaKey: stored.key,
        mediaType: file.mimeType,
        filename: media.filename ?? file.filename,
      };
    } catch (err) {
      this.logger.warn(
        `[whatsapp] inbound media store failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  @Public()
  @Post('frejun')
  frejunInbound(): { message: string; phase: number } {
    return { message: 'FreJun inbound handler lands in Week 8', phase: 1 };
  }
}

// ── helpers ─────────────────────────────────────────────────────────

/** Extract supported inbound media (image/video/audio/document) from a Meta
 *  message. Returns null when the message isn't a media type we handle. */
function extractMedia(message: {
  type?: string;
  image?: { id?: string };
  video?: { id?: string };
  audio?: { id?: string };
  document?: { id?: string; filename?: string };
}): { type: string; mediaId: string; filename?: string } | null {
  if (message.type === 'image' && typeof message.image?.id === 'string') {
    return { type: 'image', mediaId: message.image.id };
  }
  if (message.type === 'video' && typeof message.video?.id === 'string') {
    return { type: 'video', mediaId: message.video.id };
  }
  if (message.type === 'audio' && typeof message.audio?.id === 'string') {
    return { type: 'audio', mediaId: message.audio.id };
  }
  if (message.type === 'document' && typeof message.document?.id === 'string') {
    return { type: 'document', mediaId: message.document.id, filename: message.document.filename };
  }
  return null;
}

/**
 * Map Meta's status string to our `OutboundStatus` enum. Returns
 * null for unknown statuses (caller logs and ignores).
 *
 *   Meta:    sent      → ours: SENT
 *   Meta:    delivered → ours: DELIVERED
 *   Meta:    read      → ours: READ
 *   Meta:    failed    → ours: FAILED
 */
function mapMetaStatus(meta: string): 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | null {
  switch (meta) {
    case 'sent':
      return 'SENT';
    case 'delivered':
      return 'DELIVERED';
    case 'read':
      return 'READ';
    case 'failed':
      return 'FAILED';
    default:
      return null;
  }
}
