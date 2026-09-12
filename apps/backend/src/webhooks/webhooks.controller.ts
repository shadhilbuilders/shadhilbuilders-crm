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
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/public.decorator';
import { prisma as barePrisma, withRlsContext } from '@shadhil/database';

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
  async whatsappInbound(
    @Body() body: MetaEnvelope,
  ): Promise<ProcessingResult> {
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
            else if (r === 'unknown-contact') result.unknownContactsUpserted += 1;
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

    return withRlsContext(
      barePrisma,
      { userId: 'CRON_SERVICE', role: 'CRON_SERVICE', teamId: '', organizationId: process.env['PUBLIC_ORG_ID'] ?? '' },
      async (tx) => {
        const updated = await tx.$executeRawUnsafe(
          `UPDATE "OutboundMessage" SET status = $1::"OutboundStatus" WHERE "wamid" = $2`,
          ourStatus,
          status.id,
        );
        if (updated === 0) {
          // Could be: (a) a status for a message we never sent (test
          // event, recovery from a different system), or (b) a status
          // arriving after the OutboundMessage row was deleted. Either
          // way, log so we can spot patterns.
          this.logger.debug(
            `No OutboundMessage matches wamid=${status.id} (status=${status.status}, phone_number_id=${metadata?.phone_number_id ?? '?'})`,
          );
          return false;
        }
        return true;
      },
    );
  }

  // ── Inbound message handler ───────────────────────────────────────
  // Returns one of: 'message' (known lead, Message row created),
  // 'unknown-contact' (unknown number, WhatsappUnknownContact row
  // upserted), 'deduped' (already processed), 'ignored' (e.g. not a
  // text message, or no message id).
  private async handleInboundMessage(
    message: {
      from?: string;
      id?: string;
      timestamp?: string | number;
      type?: string;
      text?: { body?: string };
      [k: string]: unknown;
    },
  ): Promise<'message' | 'unknown-contact' | 'deduped' | 'ignored'> {
    if (!message.id || !message.from) return 'ignored';
    const externalId = message.id;
    const phoneE164 = toE164(message.from);
    if (!phoneE164) return 'ignored';

    // Only text messages in T-E2b; the broader media-handling
    // (image/audio/document) is a separate task. We still record
    // the inbound in WebhookEvent so the dedup covers it, but
    // skip the Message insert.
    const isText = message.type === 'text' && typeof message.text?.body === 'string';
    const body = isText ? message.text!.body! : null;

    return withRlsContext(
      barePrisma,
      { userId: 'CRON_SERVICE', role: 'CRON_SERVICE', teamId: '', organizationId: process.env['PUBLIC_ORG_ID'] ?? '' },
      async (tx) => {
        // 1) Dedup via WebhookEvent.externalId unique constraint.
        // If the same Meta event arrives twice (Meta retries), the
        // second insert fails with P2002 and we short-circuit.
        try {
          await tx.webhookEvent.create({
            data: {
              source: 'WHATSAPP',
              externalId,
              payload: message as object,
              organizationId: process.env['PUBLIC_ORG_ID'] ?? '',
            },
          });
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'P2002') return 'deduped';
          throw e;
        }

        // 2) Find the lead by phoneE164.
        const lead = await tx.lead.findUnique({
          where: { phoneE164 },
          select: { id: true, name: true },
        });

        if (lead) {
          // 3a) Known lead - create the Message row (text only in
          // T-E2b; media handling is a follow-up). Use $executeRaw
          // with a parameterized INSERT to avoid Prisma's typed API
          // path which has an RLS interaction quirk with the
          // CRON_SERVICE bypass policy (verified empirically:
          // typed `tx.message.create` fails 42501 even with the
          // role set; raw `INSERT INTO` succeeds - same tx, same
          // role, same connection).
          if (isText) {
            const msgId = `wa_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            await tx.$executeRawUnsafe(
              `INSERT INTO "Message" (id, "organizationId", "leadId", "userId", direction, channel, body, "externalId", "createdAt") VALUES ($1, $2, $3, NULL, 'IN', 'WHATSAPP', $4, $5, NOW())`,
              msgId,
              process.env['PUBLIC_ORG_ID'] ?? '',
              lead.id,
              body!,
              externalId,
            );
            return 'message';
          }
          // Non-text from a known lead: still record the WebhookEvent
          // (already done above) but skip the Message insert. The
          // user can see the event in the WebhookEvent log if they
          // need to debug.
          return 'ignored';
        }

        // 3b) Unknown number - upsert WhatsappUnknownContact. We
        // deliberately do NOT auto-create a Lead (per the T-E2b
        // product decision: don't create Leads on unknown inbound).
        // The telecaller can process the contact from the
        // follow-up queue (UI ships Week 8+; queryable via psql
        // today).
        if (isText) {
          const ts = message.timestamp
            ? new Date(Number(message.timestamp) * 1000)
            : new Date();
          await tx.whatsappUnknownContact.upsert({
            where: { phoneE164 },
            create: {
              phoneE164,
              firstMessageAt: ts,
              lastMessageAt: ts,
              firstMessageBody: body!,
            },
            update: {
              lastMessageAt: ts,
              messageCount: { increment: 1 },
            },
          });
          return 'unknown-contact';
        }
        return 'ignored';
      },
    );
  }

  @Public()
  @Post('frejun')
  frejunInbound(): { message: string; phase: number } {
    return { message: 'FreJun inbound handler lands in Week 8', phase: 1 };
  }
}

// ── helpers ─────────────────────────────────────────────────────────

/**
 * Normalize a phone number to E.164 (digits only, no leading '+').
 * Mirrors `toE164` from `~/workspace/shadhil-projects/landing-page/lib/whatsapp.ts`
 * - both codebases share the same Meta integration, so the rules
 * for "what counts as E.164" must match exactly.
 */
function toE164(raw: string): string {
  let digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  return digits;
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
function mapMetaStatus(
  meta: string,
): 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | null {
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
