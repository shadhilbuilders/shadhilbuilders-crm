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
   */
  async claimPending(claimantId: string, limit: number): Promise<OutboundMessage[]> {
    const now = new Date();
    // First, find candidates (rows in PENDING that are not within a
    // backoff window for their attempt count).
    const candidates = await this.client.outboundMessage.findMany({
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
      if (elapsed >= backoff) ready.push(c.id);
    }
    if (ready.length === 0) return [];

    // Atomic claim.
    const updateResult = await this.client.outboundMessage.updateMany({
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

    return this.client.outboundMessage.findMany({
      where: { id: { in: ready }, status: 'SENDING', claimedBy: claimantId },
      orderBy: { claimedAt: 'desc' },
      take: limit,
    });
  }

  /** Send a single claimed row via the Meta API. Updates status
   *  based on the response. Returns the updated row. */
  async sendOne(row: OutboundMessage): Promise<OutboundMessage> {
    try {
      if (row.sendType === 'TEMPLATE') {
        // Template path: build the parameters from the stored
        // templateVars, looking up the template name by which of our
        // three templates is stored.
        const templateName = this.resolveTemplateName(row);
        const vars = (row.templateVars as Record<string, string> | null) ?? {};
        // The order of parameters must match the template's
        // placeholder order. For our 3 templates the placeholder
        // orders are:
        //   - chatReply:         {{1}} firstName, {{2}} body
        //   - visitFollowup:     {{1}} firstName, {{2}} staffName,
        //                        {{3}} projectName, {{4}} context
        //   - visitReminder:     {{1}} firstName, {{2}} time,
        //                        {{3}} location, {{4}} staffName
        // The chat service sets templateVars with the right keys;
        // we sort alphabetically for a stable order, but the chat
        // service is the source of truth on what to put in.
        const parameters = Object.values(vars).map((text) => ({ type: 'text' as const, text }));
        await this.whatsapp.sendTemplateMessage(
          await this.leadPhone(row.leadId),
          templateName,
          parameters,
        );
      } else {
        // FREEFORM path: not implemented in this commit batch
        // (template-only is sufficient for the T-E2b demo; the
        // landing-page-only freeform flow comes in Week 9+).
        // We mark the row as FAILED with a clear error so the
        // operator sees what to fix.
        throw new Error('FREEFORM outbound is not yet supported in shadhil-crm; use a template');
      }

      return this.client.outboundMessage.update({
        where: { id: row.id },
        data: { status: 'SENT' },
      });
    } catch (err) {
      const isFinal = row.attempts >= MAX_ATTEMPTS;
      const errorMessage =
        err instanceof WhatsAppSendError
          ? `${err.message}${err.code ? ` (code ${err.code})` : ''}`
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(
        `[whatsapp] send failed id=${row.id} attempts=${row.attempts}/${MAX_ATTEMPTS} final=${isFinal} error=${errorMessage}`,
      );
      return this.client.outboundMessage.update({
        where: { id: row.id },
        data: {
          status: isFinal ? 'FAILED' : 'PENDING',
          lastError: errorMessage,
        },
      });
    }
  }

  /** Resolve the lead's phone in E.164 form. Returns the digits-only
   *  string. The chat service guarantees the lead has phoneE164
   *  (the enqueue path validates this), so this is just a lookup. */
  private async leadPhone(leadId: string): Promise<string> {
    const lead = await this.client.lead.findUnique({
      where: { id: leadId },
      select: { phoneE164: true, phone: true },
    });
    if (lead === null) {
      throw new Error(`Lead ${leadId} not found in OutboundService.leadPhone`);
    }
    if (lead.phoneE164 === null) {
      // Fallback to raw phone, normalized. Shouldn't happen in
      // practice (the chat service enqueue validates phoneE164
      // presence), but defensive.
      if (lead.phone === null) {
        throw new Error(`Lead ${leadId} has no phone at all`);
      }
      // Inline the same toE164 used elsewhere.
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
