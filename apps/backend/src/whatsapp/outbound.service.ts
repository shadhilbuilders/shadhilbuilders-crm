// T-E2b: OutboundMessage service — outbox pattern for staff→lead
// WhatsApp messages.
//
// Pattern: the chat service writes Message + OutboundMessage in one
// transaction (so a failed message insert never leaves a half-sent
// outbox row). A cron processor (apps/backend/src/cron/) calls
// `claimAndSend()` every 5s to claim PENDING rows via the
// T-G4-style claim lease, call the Meta API, and update status.
//
// This file is the "library" — pure logic, no NestJS decorators,
// no cron wiring. The cron processor (separate file) imports
// these functions and runs them on a schedule. Testable in
// isolation with a mock WhatsAppClient.

import { Injectable, Logger } from '@nestjs/common';
import {
  type OutboundMessage,
  type OutboundStatus,
  type PrismaClient,
  type OutboundSendType,
  withRlsContext,
} from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
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
    private readonly prismaService: PrismaService,
    private readonly whatsapp: WhatsAppClient,
    private readonly templateNames: {
      chatReply: string;
      visitFollowup: string;
      visitReminder: string;
    } = {
      chatReply: process.env.WHATSAPP_TEMPLATE_CHAT_REPLY ?? 'shadhil_chat_reply',
      visitFollowup: process.env.WHATSAPP_TEMPLATE_VISIT_FOLLOWUP ?? 'shadhil_visit_followup',
      visitReminder: process.env.WHATSAPP_TEMPLATE_VISIT_REMINDER ?? 'shadhil_visit_reminder',
    },
  ) {}

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
  async enqueue(opts: {
    messageId: string;
    leadId: string;
    sendType: OutboundSendType;
    freeformBody?: string;
    templateName?: string;
    templateVars?: Record<string, string>;
  }): Promise<OutboundMessage> {
    return this.client.outboundMessage.create({
      data: {
        messageId: opts.messageId,
        leadId: opts.leadId,
        sendType: opts.sendType,
        ...(opts.freeformBody !== undefined ? { freeformBody: opts.freeformBody } : {}),
        ...(opts.templateName !== undefined ? { templateName: opts.templateName } : {}),
        ...(opts.templateVars !== undefined ? { templateVars: opts.templateVars } : {}),
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
   * returns zero rows from findMany — see commit b2f94ca where
   * the chat-service enqueue path was in-staff-RLS-context but
   * the cron path was missed).
   */
  async claimPending(claimantId: string, limit: number): Promise<OutboundMessage[]> {
    return withRlsContext(
      this.client,
      { userId: 'CRON_SERVICE', role: 'CRON_SERVICE', teamId: '' },
      async (tx) => {
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
      },
    );
  }

  /** Send a single claimed row via the Meta API. Updates status
   *  based on the response. Returns the updated row.
   *
   *  The Meta call is outside the RLS transaction (it's a network
   *  call, not a DB call). The DB writes — both the success
   *  UPDATE (→ SENT) and the failure UPDATE (→ PENDING/FAILED with
   *  lastError) — run inside withRlsContext(CRON_SERVICE) so the
   *  outbound_cron_service_all / outbound_update_cron_service
   *  RLS policies match. The lead phone lookup is also inside
   *  RLS context (uses Lead which has its own CRON_SERVICE bypass
   *  policy from the T-E2b inbound commit).
   *
   *  On success we also store the Meta wamid in the OutboundMessage
   *  row — the inbound webhook (webhooks.controller.ts) uses this
   *  to correlate delivery receipts back to the right outbox row. */
  async sendOne(row: OutboundMessage): Promise<OutboundMessage> {
    // First, do the network call OUTSIDE the RLS transaction.
    // (RLS transaction holds a connection; the Meta fetch is a
    // blocking call to graph.facebook.com — we don't want to pin
    // a pool connection for the duration of a 30s+ HTTP call.)
    let deliveryResult:
      | { ok: true; wamid: string | null }
      | { ok: false; error: string };
    try {
      if (row.sendType === 'TEMPLATE') {
        const templateName = this.resolveTemplateName(row);
        const vars = (row.templateVars as Record<string, string> | null) ?? {};
        const parameters = Object.values(vars).map((text) => ({
          type: 'text' as const,
          text,
        }));
        const delivery = await this.whatsapp.sendTemplateMessage(
          await this.leadPhone(row.leadId),
          templateName,
          parameters,
        );
        // Meta can return HTTP 200 with message_status: 'failed' in
        // the body (the "soft failure" case — recipient not on the
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
        throw new Error(
          'FREEFORM outbound is not yet supported in shadhil-crm; use a template',
        );
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
    return withRlsContext(
      this.client,
      { userId: 'CRON_SERVICE', role: 'CRON_SERVICE', teamId: '' },
      async (tx) => {
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
      },
    );
  }

  /** Resolve the lead's phone in E.164 form. Returns the digits-only
   *  string. The chat service guarantees the lead has phoneE164
   *  (the enqueue path validates this), so this is just a lookup.
   *  Wrapped in withRlsContext(CRON_SERVICE) so the
   *  lead_select_cron_service policy from the T-E2b inbound commit
   *  matches — the bare shadhil_app role has no RLS context, so
   *  a direct findUnique would return null. */
  private async leadPhone(leadId: string): Promise<string> {
    const lead = await withRlsContext(
      this.client,
      { userId: 'CRON_SERVICE', role: 'CRON_SERVICE', teamId: '' },
      async (tx) =>
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
    if (row.templateName === this.templateNames.visitFollowup) return this.templateNames.visitFollowup;
    if (row.templateName === this.templateNames.visitReminder) return this.templateNames.visitReminder;
    // Fallback: if the row was enqueued with a template name we
    // don't recognize, pass it through verbatim (Meta will reject
    // the unknown name with a 400).
    return row.templateName ?? this.templateNames.chatReply;
  }
}

export type { OutboundStatus };
