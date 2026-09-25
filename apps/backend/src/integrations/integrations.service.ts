// Integrations service - read-only ops feeds for the WhatsApp/Meta webhook
// pipeline (READ ONLY - no write endpoints).
//
//   GET /api/integrations/webhook-events     (ADMIN/OWNER)
//   GET /api/integrations/whatsapp-delivery  (ADMIN/OWNER)
//
// RLS is the visibility gate:
//   - WebhookEvent: webhook_select_admin policy (ADMIN, org-scoped). OWNER
//     travels as admin-class (isAdminClass) and the policy keyed on ADMIN -
//     see the note on OWNER-vs-ADMIN in the service.
//   - OutboundMessage: outbound_cron_service_select (CRON_SERVICE, org-scoped)
//     has NO admin SELECT policy yet (2026-09-11). A migration adds
//     outbound_select_admin so ADMIN/OWNER can read the delivery feed; until
//     applied, this module would return zero rows for staff reads.
import {
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import {
  withRlsContext,
  rlsContextFrom,
  type PrismaClient,
} from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type {
  WebhookEventRow,
  WebhookEventsQuery,
  WhatsAppDeliveryQuery,
  WhatsAppDeliveryRow,
} from '@shadhil/api-types';
import { isAdminClass } from '../users/roles';

import { PrismaService } from '../prisma/prisma.module';

export interface WebhookEventsListResult {
  total: number;
  rows: WebhookEventRow[];
}
export interface WhatsAppDeliveryListResult {
  total: number;
  rows: WhatsAppDeliveryRow[];
}
export interface IntegrationListEnvelope {
  total: number;
  rows: WebhookEventRow[] | WhatsAppDeliveryRow[];
}

@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  private assertAdmin(actor: JwtPayload): void {
    // Service-side guard (the RLS policy is the second wall). ADMIN/OWNER
    // only - mirrors the audit module guard.
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException(
        'Only ADMIN or OWNER can view integration telemetry',
      );
    }
  }

  /**
   * GET /api/integrations/webhook-events - raw inbound webhook events.
   * Ordered newest-first; filterable by source + processed flag.
   */
  async listWebhookEvents(
    actor: JwtPayload,
    dto: WebhookEventsQuery,
  ): Promise<WebhookEventsListResult> {
    this.assertAdmin(actor);
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const where: Record<string, unknown> = {};
      if (dto.source !== undefined) where['source'] = dto.source;
      if (dto.processed !== undefined) where['processed'] = dto.processed;

      const [rows, total] = await Promise.all([
        (tx as unknown as PrismaClient).webhookEvent.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: dto.limit,
          skip: dto.offset,
          select: {
            id: true,
            source: true,
            externalId: true,
            processed: true,
            processedAt: true,
            error: true,
            payload: true,
            createdAt: true,
          },
        }),
        (tx as unknown as PrismaClient).webhookEvent.count({ where }),
      ]);

      return {
        total,
        rows: rows.map((r) => ({
          id: r.id,
          source: r.source,
          externalId: r.externalId,
          processed: r.processed,
          processedAt: r.processedAt
            ? r.processedAt.toISOString()
            : null,
          error: r.error,
          payload: r.payload as Record<string, unknown>,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    });
  }

  /**
   * GET /api/integrations/whatsapp-delivery - outbound message delivery
   * feed. Join lead for a display name; status reflects the latest Meta
   * status callback (SENT → DELIVERED → READ / FAILED).
   */
  async listWhatsAppDelivery(
    actor: JwtPayload,
    dto: WhatsAppDeliveryQuery,
  ): Promise<WhatsAppDeliveryListResult> {
    this.assertAdmin(actor);
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const where: Record<string, unknown> = {};
      if (dto.status !== undefined) where['status'] = dto.status;

      const [rows, total] = await Promise.all([
        (tx as unknown as PrismaClient).outboundMessage.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: dto.limit,
          skip: dto.offset,
          select: {
            id: true,
            leadId: true,
            contactId: true,
            lead: { select: { name: true } },
            // T-WA-INBOX: an outbound reply to an unknown number has no lead,
            // so the feed resolves a display name from the contact's phone
            // instead of the lead join.
            contact: { select: { phoneE164: true } },
            sendType: true,
            templateName: true,
            status: true,
            attempts: true,
            lastError: true,
            wamid: true,
            claimedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        (tx as unknown as PrismaClient).outboundMessage.count({ where }),
      ]);

      return {
        total,
        rows: rows.map((r) => ({
          id: r.id,
          leadId: r.leadId,
          contactId: r.contactId,
          // Lead thread -> the lead's name. Contact thread -> the phone (there
          // is no name for an unresolved number). Never a blank cell.
          leadName: r.lead?.name ?? r.contact?.phoneE164 ?? '',
          sendType: r.sendType,
          templateName: r.templateName,
          status: r.status,
          attempts: r.attempts,
          lastError: r.lastError,
          wamid: r.wamid,
          claimedAt: r.claimedAt ? r.claimedAt.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
    });
  }
}
