// T-E2b: OutboundMessage service - outbox pattern for staff→lead
// WhatsApp messages.
//
// Pattern: the chat service writes Message + OutboundMessage in one
// transaction (so a failed message insert never leaves a half-sent
// outbox row). A cron processor (apps/backend/src/cron/) calls
// `claimAndSend()` every 5s to claim PENDING rows via the
// T-G4-style claim lease, call the Meta API, and update status.
//
// This file is the "library" - pure logic, no NestJS decorators,
// no cron wiring. The cron processor (separate file) imports
// these functions and runs them on a schedule. Testable in
// isolation with a mock WhatsAppClient.

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  type OutboundMessage,
  type OutboundStatus,
  type PrismaClient,
  type OutboundSendType,
  withRlsContext,
} from '@shadhil/database';

import { cronContextFor, listOrganizationIds } from '../common/cron-orgs';
import { PrismaService } from '../prisma/prisma.module';
import { STORAGE_PROVIDER } from '../storage/storage.tokens';
import type { StorageProvider } from '../storage/storage.provider';
import { WhatsAppClient, WhatsAppSendError } from './whatsapp.client';

/** Cap on retry attempts before marking the row FAILED. After
 *  MAX_ATTEMPTS failures, we don't try again. */
export const MAX_ATTEMPTS = 4;

/** Backoff schedule (ms) per attempt. Index 0 = first retry, etc. */
const BACKOFF_MS = [
  30_000, // attempt 1: 30s after the first failure
  5 * 60_000, // attempt 2: 5 min
  60 * 60_000, // attempt 3: 1 hour
  4 * 60 * 60_000, // attempt 4: 4 hours (last attempt before FAILED)
];

@Injectable()
export class OutboundService {
  private readonly logger = new Logger(OutboundService.name);

  constructor(
    // @Inject is REQUIRED on every dep (not style): tsx/esbuild doesn't
    // emit design:paramtypes for bare params, so Nest injects undefined
    // and every cron tick crashes with "Cannot read properties of
    // undefined (reading '$client')".
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(WhatsAppClient) private readonly whatsapp: WhatsAppClient,
    // MEDIA (2026-09-17): storage for outbound attachments - read file bytes
    // back and upload them to Meta's /media. @Optional so the direct-construct
    // test harness keeps working without wiring StorageModule.
    @Optional() @Inject(STORAGE_PROVIDER) private readonly storage?: StorageProvider,
  ) {}

  // Template names resolved from env (never injected - they have no DI token).
  private readonly templateNames: {
    chatReply: string;
    visitFollowup: string;
    visitReminder: string;
  } = {
    chatReply: process.env.WA_TEMPLATE_CHAT_REPLY ?? 'shadhil_chat_reply',
    visitFollowup: process.env.WA_TEMPLATE_VISIT_FOLLOWUP ?? 'shadhil_visit_followup',
    visitReminder: process.env.WA_TEMPLATE_VISIT_REMINDER ?? 'shadhil_visit_reminder',
  };

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * Enqueue an outbound message. Called from the chat service after
   * a successful `Message.create` with channel=WHATSAPP. Atomically
   * writes the outbox row in the same transaction as the message
   * (or, for non-transactional callers, as a follow-up insert that's
   * also OK on its own).
   */
  async enqueue(
    opts: {
      messageId: string;
      // T-WA-INBOX (2026-09-25): exactly one of leadId/contactId is set -
      // mirrors Message's thread columns and the outbound_message_thread_exactly_one
      // CHECK constraint. A reply to an unknown number targets contactId.
      leadId?: string;
      contactId?: string;
      /** Tenant that owns the thread (the acting user's org). Required: it used
       *  to be read from PUBLIC_ORG_ID, which stamped every org's rows with one id. */
      organizationId: string;
      sendType: OutboundSendType;
      freeformBody?: string;
      templateName?: string;
      templateVars?: Record<string, string>;
      // MEDIA (2026-09-17): optional attachment for the outbound cron.
      mediaKey?: string;
      mediaType?: string;
      mediaFilename?: string;
    },
    // RLS-scoped client/transaction override. The chat service enqueues
    // from INSIDE a withRlsContext(tx) block (which sets app.user_id etc.
    // on that transaction's connection). Prisma does NOT propagate those
    // GUCs to the bare injected client, so a bare-client INSERT hits
    // outbound_insert_authenticated with no user → 42501. Passing the
    // caller's tx client keeps the insert on the same RLS-scoped
    // connection as the Message row it belongs to (atomic, policy-clean).
    clientOverride?: PrismaClient,
  ): Promise<OutboundMessage> {
    const client = clientOverride ?? this.client;
    // Enforce the single-thread rule in code as well as in the DB CHECK, so a
    // caller that forgets one gets a clear error instead of a constraint
    // violation surfacing as an opaque 500.
    const hasLead = opts.leadId !== undefined;
    const hasContact = opts.contactId !== undefined;
    if (hasLead === hasContact) {
      throw new Error(
        `OutboundService.enqueue requires exactly one of leadId/contactId (got leadId=${hasLead}, contactId=${hasContact})`,
      );
    }
    return client.outboundMessage.create({
      data: {
        messageId: opts.messageId,
        ...(opts.leadId !== undefined ? { leadId: opts.leadId } : {}),
        ...(opts.contactId !== undefined ? { contactId: opts.contactId } : {}),
        sendType: opts.sendType,
        organizationId: opts.organizationId,
        ...(opts.freeformBody !== undefined ? { freeformBody: opts.freeformBody } : {}),
        ...(opts.templateName !== undefined ? { templateName: opts.templateName } : {}),
        ...(opts.templateVars !== undefined ? { templateVars: opts.templateVars } : {}),
        // MEDIA: persist the attachment metadata on the outbox row.
        ...(opts.mediaKey !== undefined ? { mediaKey: opts.mediaKey } : {}),
        ...(opts.mediaType !== undefined ? { mediaType: opts.mediaType } : {}),
        ...(opts.mediaFilename !== undefined ? { mediaFilename: opts.mediaFilename } : {}),
        status: 'PENDING',
      },
    });
  }

  /**
   * Claim a batch of PENDING rows for processing. Uses the T-G4
   * claim-lease pattern: updateMany sets status=SENDING and
   * claimedAt/claimedBy atomically. Rows whose `lastAttemptAt` is
   * within the backoff window are skipped.
   *
   * Wraps all DB operations in `withRlsContext(CRON_SERVICE)` so
   * the outbound_cron_service_all RLS policy matches (the bare
   * shadhil_app role has no RLS context set, so a direct call
   * returns zero rows from findMany - see commit b2f94ca where
   * the chat-service enqueue path was in-staff-RLS-context but
   * the cron path was missed).
   */
  async claimPending(claimantId: string, limit: number): Promise<OutboundMessage[]> {
    // T-CRON-MULTITENANT: claim per organization, each in its own CRON_SERVICE
    // context, until the batch limit is filled.
    const claimed: OutboundMessage[] = [];
    const orgIds = await listOrganizationIds(this.client);
    for (const organizationId of orgIds) {
      const remaining = limit - claimed.length;
      if (remaining <= 0) break;
      claimed.push(...(await this.claimPendingForOrg(claimantId, remaining, organizationId)));
    }
    return claimed;
  }

  private async claimPendingForOrg(
    claimantId: string,
    limit: number,
    organizationId: string,
  ): Promise<OutboundMessage[]> {
    return withRlsContext(this.client, cronContextFor(organizationId), async (tx) => {
      const now = new Date();
      // First, find candidates (rows in PENDING that are not within a
      // backoff window for their attempt count).
      const candidates = await (tx as unknown as PrismaClient).outboundMessage.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: limit * 3, // overshoot; updateMany will narrow to limit
        select: { id: true, attempts: true, lastAttemptAt: true },
      });
      const ready: string[] = [];
      for (const c of candidates) {
        if (ready.length >= limit) break;
        if (c.lastAttemptAt === null) {
          ready.push(c.id);
          continue;
        }
        const backoff = BACKOFF_MS[Math.min(c.attempts, BACKOFF_MS.length - 1)];
        const elapsed = now.getTime() - c.lastAttemptAt.getTime();
        if (elapsed >= backoff) {
          ready.push(c.id);
        }
      }
      if (ready.length === 0) return [];

      // Atomic claim.
      const updateResult = await (tx as unknown as PrismaClient).outboundMessage.updateMany({
        where: { id: { in: ready }, status: 'PENDING' },
        data: {
          status: 'SENDING',
          claimedAt: now,
          claimedBy: claimantId,
          attempts: { increment: 1 },
          lastAttemptAt: now,
        },
      });
      if (updateResult.count === 0) return [];

      return (tx as unknown as PrismaClient).outboundMessage.findMany({
        where: { id: { in: ready }, status: 'SENDING', claimedBy: claimantId },
        orderBy: { claimedAt: 'desc' },
        take: limit,
      });
    });
  }

  /** Send a single claimed row via the Meta API. Updates status
   *  based on the response. Returns the updated row.
   *
   *  The Meta call is outside the RLS transaction (it's a network
   *  call, not a DB call). The DB writes - both the success
   *  UPDATE (→ SENT) and the failure UPDATE (→ PENDING/FAILED with
   *  lastError) - run inside withRlsContext(CRON_SERVICE) so the
   *  outbound_cron_service_all / outbound_update_cron_service
   *  RLS policies match. The lead phone lookup is also inside
   *  RLS context (uses Lead which has its own CRON_SERVICE bypass
   *  policy from the T-E2b inbound commit).
   *
   *  On success we also store the Meta wamid in the OutboundMessage
   *  row - the inbound webhook (webhooks.controller.ts) uses this
   *  to correlate delivery receipts back to the right outbox row. */
  async sendOne(row: OutboundMessage): Promise<OutboundMessage> {
    // First, do the network call OUTSIDE the RLS transaction.
    // (RLS transaction holds a connection; the Meta fetch is a
    // blocking call to graph.facebook.com - we don't want to pin
    // a pool connection for the duration of a 30s+ HTTP call.)
    let deliveryResult: { ok: true; wamid: string | null } | { ok: false; error: string };
    try {
      if (row.sendType === 'TEMPLATE') {
        const templateName = this.resolveTemplateName(row);
        const vars = (row.templateVars as Record<string, string> | null) ?? {};
        // Map the row's `templateVars` (the chat service populates
        // this with the right keys for the template) into the
        // ordered Meta `parameters` array. The order of values
        // MUST match the {{1}}, {{2}}, ... placeholder order in the
        // template body - Meta rejects out-of-order parameters.
        // See apps/backend/src/whatsapp/whatsapp.client.ts for
        // the full template specs (3 templates: shadhil_chat_reply,
        // shadhil_visit_followup, shadhil_visit_reminder).
        //
        // We sort the values alphabetically by key for a stable
        // order. The chat service writes the keys in a specific
        // order ('1', '2', '3', '4') so alphabetical sort == the
        // intended Meta order. If you add a template with 3+ vars,
        // keep the keys as zero-padded strings to preserve the
        // alphabetical == numeric ordering.
        const parameters = Object.entries(vars)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => ({ type: 'text' as const, text }));
        const delivery = await this.whatsapp.sendTemplateMessage(
          await this.threadPhone(row),
          templateName,
          parameters,
        );
        // Meta can return HTTP 200 with message_status: 'failed' in
        // the body (the "soft failure" case - recipient not on the
        // test allowlist, undeliverable, etc.). Treat as a hard
        // failure so we go through the backoff path.
        if (!delivery.accepted) {
          deliveryResult = {
            ok: false,
            error: `Meta refused: code=${delivery.errorCode} title=${delivery.errorTitle}`,
          };
        } else {
          deliveryResult = { ok: true, wamid: delivery.wamid };
        }
      } else {
        // FREEFORM (chat replies): send raw text. This is valid within
        // Meta's 24h customer-service window (a reply to the customer's
        // inbound) and does NOT require an approved template - templates
        // are only needed OUTSIDE the window or for proactive (started-by-
        // business) messages. The body lives in `freeformBody`.
        //
        // MEDIA: when the row carries mediaKey/mediaType/mediaFilename, send
        // an attachment instead (upload bytes → Meta, then a media message).
        const hasMedia = row.mediaKey !== null && row.mediaKey !== undefined;
        if (hasMedia) {
          deliveryResult = await this.sendMedia(row);
        } else {
          const text = row.freeformBody ?? '';
          if (text.length === 0) {
            throw new Error('FREEFORM outbound row has no freeformBody');
          }
          const delivery = await this.whatsapp.sendTextMessage(await this.threadPhone(row), text);
          if (!delivery.accepted) {
            deliveryResult = {
              ok: false,
              error: `Meta refused: code=${delivery.errorCode} title=${delivery.errorTitle}`,
            };
          } else {
            deliveryResult = { ok: true, wamid: delivery.wamid };
          }
        }
      }
    } catch (err) {
      const errorMessage =
        err instanceof WhatsAppSendError
          ? `${err.message}${err.code ? ` (code ${err.code})` : ''}`
          : err instanceof Error
            ? err.message
            : String(err);
      deliveryResult = { ok: false, error: errorMessage };
    }

    // Now do the DB write inside the RLS transaction.
    return withRlsContext(this.client, cronContextFor(row.organizationId), async (tx) => {
      const txClient = tx as unknown as PrismaClient;
      if (deliveryResult.ok) {
        return txClient.outboundMessage.update({
          where: { id: row.id },
          data: {
            status: 'SENT',
            wamid: deliveryResult.wamid,
          },
        });
      }
      const isFinal = row.attempts >= MAX_ATTEMPTS;
      this.logger.warn(
        `[whatsapp] send failed id=${row.id} attempts=${row.attempts}/${MAX_ATTEMPTS} final=${isFinal} error=${deliveryResult.error}`,
      );
      return txClient.outboundMessage.update({
        where: { id: row.id },
        data: {
          status: isFinal ? 'FAILED' : 'PENDING',
          lastError: deliveryResult.error,
        },
      });
    });
  }

  /** Resolve the lead's phone in E.164 form. Returns the digits-only
   *  string. The chat service guarantees the lead has phoneE164
   *  (the enqueue path validates this), so this is just a lookup.
   *  Wrapped in withRlsContext(CRON_SERVICE) so the
   *  lead_select_cron_service policy from the T-E2b inbound commit
   *  matches - the bare shadhil_app role has no RLS context, so
   *  a direct findUnique would return null. */
  /** T-WA-INBOX (2026-09-25): resolve the destination phone for whichever
   *  thread an outbound row targets. A row has exactly one of leadId/contactId
   *  (DB CHECK), so this dispatches rather than duplicating the send path. */
  private async threadPhone(row: OutboundMessage): Promise<string> {
    if (row.contactId !== null && row.contactId !== undefined) {
      const contact = await withRlsContext(
        this.client,
        cronContextFor(row.organizationId),
        async (tx) =>
          (tx as unknown as PrismaClient).whatsappUnknownContact.findUnique({
            where: { id: row.contactId as string },
            select: { phoneE164: true },
          }),
      );
      if (contact === null) {
        throw new Error(
          `WhatsappUnknownContact ${row.contactId} not found in OutboundService.threadPhone`,
        );
      }
      return contact.phoneE164;
    }
    if (row.leadId === null || row.leadId === undefined) {
      throw new Error(
        `OutboundMessage ${row.id} has neither leadId nor contactId - cannot resolve a destination`,
      );
    }
    return this.leadPhone(row.leadId, row.organizationId);
  }

  private async leadPhone(leadId: string, organizationId: string): Promise<string> {
    const lead = await withRlsContext(this.client, cronContextFor(organizationId), async (tx) =>
      (tx as unknown as PrismaClient).lead.findUnique({
        where: { id: leadId },
        select: { phoneE164: true, phone: true },
      }),
    );
    if (lead === null) {
      throw new Error(`Lead ${leadId} not found in OutboundService.leadPhone`);
    }
    if (lead.phoneE164 === null) {
      if (lead.phone === null) {
        throw new Error(`Lead ${leadId} has no phone at all`);
      }
      return lead.phone.replace(/[\s\-().+]/g, '');
    }
    return lead.phoneE164;
  }

  /** Map a row's `templateName` (or, if missing, infer from
   *  `sendType`) to the actual Meta template name. */
  private resolveTemplateName(row: OutboundMessage): string {
    // The chat service sets the env-var-resolved template name
    // already (via the OutboundService templateNames arg). The
    // raw value in `row.templateName` is one of the 3 we know about.
    if (row.templateName === this.templateNames.chatReply) return this.templateNames.chatReply;
    if (row.templateName === this.templateNames.visitFollowup)
      return this.templateNames.visitFollowup;
    if (row.templateName === this.templateNames.visitReminder)
      return this.templateNames.visitReminder;
    // Fallback: if the row was enqueued with a template name we
    // don't recognize, pass it through verbatim (Meta will reject
    // the unknown name with a 400).
    return row.templateName ?? this.templateNames.chatReply;
  }

  /**
   * Send an attachment for a FREEFORM row: read the stored bytes, upload
   * them to Meta's /media, then send a media message. Returns the same
   * deliveryResult shape the rest of sendOne produces.
   */
  private async sendMedia(
    row: OutboundMessage,
  ): Promise<{ ok: true; wamid: string | null } | { ok: false; error: string }> {
    if (this.storage === undefined) {
      return { ok: false, error: 'Storage provider not configured (media outbound)' };
    }
    if (row.mediaKey === null || row.mediaKey === undefined) {
      return { ok: false, error: 'mediaKey missing on outbound row' };
    }
    const bytes = await this.storage.read(row.mediaKey);
    if (bytes === null) {
      return { ok: false, error: `Stored media not found: ${row.mediaKey}` };
    }

    const mime = row.mediaType ?? 'application/octet-stream';
    const filename = row.mediaFilename ?? 'file';
    // Map mime → Meta message type.
    const metaType = mediaTypeFor(mime);
    if (metaType === null) {
      return { ok: false, error: `Unsupported media mime: ${mime}` };
    }

    const mediaId = await this.whatsapp.uploadMedia({ buffer: bytes, mimeType: mime, filename });
    const caption = row.freeformBody ?? undefined;
    const delivery = await this.whatsapp.sendMediaMessage(await this.threadPhone(row), {
      mediaId,
      type: metaType,
      ...(metaType === 'document' ? { filename } : {}),
      ...(caption !== undefined && caption.length > 0 ? { caption } : {}),
    });
    if (!delivery.accepted) {
      return {
        ok: false,
        error: `Meta refused: code=${delivery.errorCode} title=${delivery.errorTitle}`,
      };
    }
    return { ok: true, wamid: delivery.wamid };
  }
}

/** Map a MIME type to the Meta message media type, or null if unsupported. */
function mediaTypeFor(mime: string): 'image' | 'document' | 'video' | 'audio' | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  // Documents: pdf + office types + text.
  if (
    mime === 'application/pdf' ||
    mime.startsWith('text/') ||
    mime.includes('officedocument') ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/msword' ||
    mime === 'application/vnd.ms-powerpoint'
  ) {
    return 'document';
  }
  return null;
}

export type { OutboundStatus };
