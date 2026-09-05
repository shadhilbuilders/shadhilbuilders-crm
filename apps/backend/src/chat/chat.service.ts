// Chat service — in-app + WhatsApp message history per Lead.
//
// Scoping (per JWT): every read/write flows through withRlsContext.
// The Message table has no userId-scoped policy — Message policies
// key off the parent Lead (activity_select_team pattern): ADMIN sees
// all, MANAGER sees team, TELECALLER/SALES_EXEC see own leads. The
// service inherits Lead-scoped visibility by virtue of the policy
// joins through Message.leadId. Symmetric with visits/bookings.
//
// Write paths (inside `withRlsContext`):
//   - send: Message creation + AuditLog row. Channel defaults to IN_APP;
//     the WhatsApp path is auto-routed by the message service if the
//     lead has consented and the channel is unset. For T-CHAT Pass 1
//     we honor the DTO's channel (the inbound WA webhook ships in
//     T-WEBHOOK and routes here too).
//
// Reads use `withRlsContext` for symmetry with the writes — the
// bare client would also work (no app.user_id is checked by the
// Message policies) but the writes need the session vars for the
// AuditLog insert's RLS gate.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  withRlsContext,
  type PrismaClient,
} from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type {
  MessageEvent,
  SendMessageDto,
} from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';
import { OutboundService } from '../whatsapp/outbound.service';

/**
 * Wire shape returned by every endpoint. Matches the MessageEvent
 * schema in packages/api-types/src/chat.ts — the web app reads these
 * fields off `query.data` in apps/web/src/app/(app)/leads/[id]/page.tsx.
 * `mediaUrl` is optional because the SSE wire shape (`MessageEvent`)
 * declares it `string | null | undefined`; the page tolerates its
 * absence.
 */
export interface MessageRow {
  id: string;
  leadId: string;
  direction: 'IN' | 'OUT';
  channel: 'WHATSAPP' | 'IN_APP';
  body: string;
  mediaUrl?: string | null | undefined;
  createdAt: string;
}

export type MessageListResult = MessageRow[];

@Injectable()
export class ChatService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(OutboundService) private readonly outbound: OutboundService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * GET /api/chat/:leadId — list messages for a lead, ordered oldest
   * first (the page renders in chronological order). Optional `since`
   * cursor filters to messages after the cursor; `limit` caps the
   * page size.
   */
  async list(
    actor: JwtPayload,
    leadId: string,
    since: string | undefined,
    limit: number,
  ): Promise<MessageListResult> {
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        // Verify the lead exists under the actor's scope — a
        // non-visible lead returns 0 messages anyway (the JOIN-based
        // policy filters them out), but surfacing a 404 helps the
        // BFF distinguish "no messages" from "no lead".
        const lead = await (tx as unknown as PrismaClient).lead.findUnique({
          where: { id: leadId },
          select: { id: true },
        });
        if (lead === null) {
          throw new NotFoundException(`Lead ${leadId} not found`);
        }

        const rows = await (tx as unknown as PrismaClient).message.findMany({
          where: {
            leadId,
            ...(since !== undefined ? { createdAt: { gt: new Date(since) } } : {}),
          },
          orderBy: { createdAt: 'asc' },
          take: limit,
          select: {
            id: true,
            leadId: true,
            direction: true,
            channel: true,
            body: true,
            mediaUrl: true,
            createdAt: true,
          },
        });

        return rows.map((r) => ({
          id: r.id,
          leadId: r.leadId,
          direction: r.direction,
          channel: r.channel,
          body: r.body,
          mediaUrl: r.mediaUrl,
          createdAt: r.createdAt.toISOString(),
        }));
      },
    );
  }

  /**
   * POST /api/chat/send — staff sends a message to a lead. The
   * direction is OUT (staff → customer). The Message table has no
   * userId-scoped policy, but we still need to satisfy the
   * AuditLog.insert RLS gate (auditlog_insert_any_authenticated:
   * app.user_id IS NOT NULL) — that's why we wrap in withRlsContext
   * even though the message insert would also work without it.
   *
   * Returns the persisted message in the SSE-friendly wire shape
   * (MessageEvent). The BFF invalidates the chat query so the
   * optimistic update lands.
   */
  async send(
    actor: JwtPayload,
    dto: SendMessageDto,
  ): Promise<MessageEvent> {
    if (dto.body.trim().length === 0) {
      throw new BadRequestException('Message body cannot be empty');
    }
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        // RLS-scoped lead check. message_insert_team gates via the
        // parent Lead's team/owner — a non-visible lead surfaces as
        // P2003 (FK violation) or a RLS rejection. We pre-check so
        // the BFF gets a clear 404 rather than a 500.
        const lead = await (tx as unknown as PrismaClient).lead.findUnique({
          where: { id: dto.leadId },
          select: { id: true, name: true },
        });
        if (lead === null) {
          throw new NotFoundException(`Lead ${dto.leadId} not found`);
        }

        const created = await (tx as unknown as PrismaClient).message.create({
          data: {
            leadId: dto.leadId,
            userId: actor.sub,
            direction: 'OUT',
            channel: dto.channel ?? 'IN_APP',
            body: dto.body,
            ...(dto.mediaUrl !== undefined ? { mediaUrl: dto.mediaUrl } : {}),
          },
          select: {
            id: true,
            leadId: true,
            direction: true,
            channel: true,
            body: true,
            mediaUrl: true,
            createdAt: true,
          },
        });

        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            action: 'chat.send',
            entityType: 'Message',
            entityId: created.id,
            after: {
              leadId: created.leadId,
              direction: created.direction,
              channel: created.channel,
            },
            reason: `Message sent to lead ${created.leadId} by ${actor.email} (${actor.role})`,
          },
        });

        // T-E2b: also look up the lead's first name in-RLS so we
        // can build the template vars without a second RLS-scoped
        // query (which would fail because the bare prisma client is
        // RLS-restricted).
        const firstName = (lead.name ?? '').trim().split(/\s+/)[0] ?? lead.name ?? '';

        // T-E2b: if the channel is WHATSAPP, enqueue an outbound
        // message. We do this INSIDE the withRlsContext block so
        // the OutboundMessage INSERT runs under the actor's RLS
        // (the outbound_insert_authenticated policy requires
        // app.user_id to be set, which the bare client can't
        // provide). The cron processor later picks it up via the
        // CRON_SERVICE role.
        if (created.channel === 'WHATSAPP') {
          const templateName = process.env.WHATSAPP_TEMPLATE_CHAT_REPLY ?? 'shadhil_chat_reply';
          const body = created.body.length > 1000 ? created.body.slice(0, 1000) : created.body;
          await this.outbound.enqueue({
            messageId: created.id,
            leadId: created.leadId,
            sendType: 'TEMPLATE',
            templateName,
            templateVars: {
              '1': firstName,
              '2': body,
            },
          });
        }

        return {
          id: created.id,
          leadId: created.leadId,
          direction: created.direction,
          channel: created.channel,
          body: created.body,
          mediaUrl: created.mediaUrl,
          createdAt: created.createdAt.toISOString(),
        };
      },
    );
  }
}
