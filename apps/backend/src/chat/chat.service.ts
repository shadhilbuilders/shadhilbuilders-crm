// Chat service - in-app + WhatsApp message history per Lead.
//
// Scoping (per JWT): every read/write flows through withRlsContext.
// The Message table has no userId-scoped policy - Message policies
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
// Reads use `withRlsContext` for symmetry with the writes - the
// bare client would also work (no app.user_id is checked by the
// Message policies) but the writes need the session vars for the
// AuditLog insert's RLS gate.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  withRlsContext, rlsContextFrom,
  type PrismaClient,
} from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type {
  MessageEvent,
  SendMessageDto,
} from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';
import { OutboundService } from '../whatsapp/outbound.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TeamAccessService } from '../teams/team-access.service';
/**
 * Wire shape returned by every endpoint. Matches the MessageEvent
 * schema in packages/api-types/src/chat.ts - the web app reads these
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
  kind?: 'CUSTOMER' | 'INTERNAL';
  body: string;
  mediaUrl?: string | null | undefined;
  // Display name of the sender. OUT = the staff member (Message.user.name);
  // IN = the customer (the lead's name). Null when unresolvable.
  senderName: string | null;
  createdAt: string;
}

export type MessageListResult = MessageRow[];

@Injectable()
export class ChatService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(OutboundService) private readonly outbound: OutboundService,
    // @Optional() (rule 7h): the notifications dep is best-effort. Existing
    // test factories construct ChatService with two args; making this
    // optional keeps them green. In production DI resolves it via the
    // @Global() NotificationsModule.
    @Optional()
    @Inject(NotificationsService)
    private readonly notifications?: NotificationsService,
  ) {}

  // T-TEAM-AUTHORITATIVE (2026-09-13): stateless helper, no DI needed -
  // instantiating directly avoids touching every existing test's
  // `new ChatService(...)` constructor call (same pattern as
  // leads.service.ts/dashboard.service.ts/etc.).
  private readonly teamAccess = new TeamAccessService();

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * GET /api/chat/:leadId - list messages for a lead, ordered oldest
   * first (the page renders in chronological order). Optional `since`
   * cursor filters to messages after the cursor; `limit` caps the
   * page size.
   */
  async list(
    actor: JwtPayload,
    leadId: string,
    since: string | undefined,
    limit: number,
    kind: 'CUSTOMER' | 'INTERNAL' = 'CUSTOMER',
  ): Promise<MessageListResult> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        // Verify the lead exists under the actor's scope - a
        // non-visible lead returns 0 messages anyway (the JOIN-based
        // policy filters them out), but surfacing a 404 helps the
        // BFF distinguish "no messages" from "no lead".
        const lead = await (tx as unknown as PrismaClient).lead.findUnique({
          where: { id: leadId },
          select: { id: true, name: true },
        });
        if (lead === null) {
          throw new NotFoundException(`Lead ${leadId} not found`);
        }

        const rows = await (tx as unknown as PrismaClient).message.findMany({
          where: {
            leadId,
            kind,
            ...(since !== undefined ? { createdAt: { gt: new Date(since) } } : {}),
          },
          orderBy: { createdAt: 'asc' },
          take: limit,
          select: {
            id: true,
            leadId: true,
            direction: true,
            channel: true,
            kind: true,
            body: true,
            mediaUrl: true,
            createdAt: true,
            user: { select: { name: true } },
          },
        });

        return rows.map((r) => ({
          id: r.id,
          leadId: r.leadId,
          direction: r.direction,
          channel: r.channel,
          kind: r.kind,
          body: r.body,
          mediaUrl: r.mediaUrl,
          // OUT → the staff member who sent it; IN → the customer (lead).
          senderName: r.direction === 'OUT' ? (r.user?.name ?? null) : lead.name,
          createdAt: r.createdAt.toISOString(),
        }));
      },
    );
  }

  /**
   * POST /api/chat/send - staff sends a message to a lead. The
   * direction is OUT (staff → customer). The Message table has no
   * userId-scoped policy, but we still need to satisfy the
   * AuditLog.insert RLS gate (auditlog_insert_any_authenticated:
   * app.user_id IS NOT NULL) - that's why we wrap in withRlsContext
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
    // Thread discriminator. INTERNAL = staff-only note (never enqueues
    // WhatsApp; the customer never sees it). Defaults to CUSTOMER so
    // existing callers (webhook, BFF) keep working unchanged.
    const kind: 'CUSTOMER' | 'INTERNAL' = dto.kind ?? 'CUSTOMER';
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        // RLS-scoped lead check. message_insert_team gates via the
        // parent Lead's team/owner - a non-visible lead surfaces as
        // P2003 (FK violation) or a RLS rejection. We pre-check so
        // the BFF gets a clear 404 rather than a 500.
        const lead = await (tx as unknown as PrismaClient).lead.findUnique({
          where: { id: dto.leadId },
          select: { id: true, name: true },
        });
        if (lead === null) {
          throw new NotFoundException(`Lead ${dto.leadId} not found`);
        }

        // The sender of an OUT message is the staff member (actor). Look up
        // their display name for the MessageHeader.
        const actorRow = await (tx as unknown as PrismaClient).user.findUnique({
          where: { id: actor.sub },
          select: { name: true },
        });

        const created = await (tx as unknown as PrismaClient).message.create({
          data: {
            leadId: dto.leadId,
            organizationId: actor.organizationId,
            userId: actor.sub,
            direction: 'OUT',
            channel: dto.channel ?? 'IN_APP',
            kind,
            body: dto.body,
            ...(dto.mediaUrl !== undefined ? { mediaUrl: dto.mediaUrl } : {}),
          },
          select: {
            id: true,
            leadId: true,
            direction: true,
            channel: true,
            kind: true,
            body: true,
            mediaUrl: true,
            createdAt: true,
          },
        });

        await (tx as unknown as PrismaClient).auditLog.create({
          data: {
            userId: actor.sub,
            organizationId: actor.organizationId,
            action: 'chat.send',
            entityType: 'Message',
            entityId: created.id,
            after: {
              leadId: created.leadId,
              direction: created.direction,
              channel: created.channel,
              kind: created.kind,
            },
            reason: `Message sent to lead ${created.leadId} by ${actor.email} (${actor.role})`,
          },
        });

        // INTERNAL messages are staff-only notes - they never reach the
        // customer, so the WhatsApp outbound path is skipped entirely.
        // This is the hard guarantee that an internal note can't leak to
        // the customer's phone even if a caller passes channel=WHATSAPP.
        if (kind === 'INTERNAL') {
          // Best-effort @mention → notification (the "loop the manager"
          // mechanism). A typo'd @Name just doesn't notify; it never
          // blocks the send. Resolve mentioned users by name within the
          // actor's team scope and emit a chat.mention notification for
          // each. The NotificationsService is @Optional() - if it's not
          // wired (unit tests), mentions are silently skipped.
          await this.emitMentions(tx, actor, dto, created.id);
        } else if (created.channel === 'WHATSAPP') {
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
          const templateName = process.env.WA_TEMPLATE_CHAT_REPLY ?? 'shadhil_chat_reply';
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
          kind: created.kind,
          body: created.body,
          mediaUrl: created.mediaUrl,
          // OUT → the staff member who sent it (the actor).
          senderName: actorRow?.name ?? null,
          createdAt: created.createdAt.toISOString(),
        };
      },
    );
  }

  /**
   * Best-effort @mention resolution for INTERNAL messages. Scans the body
   * for `@Name` tokens, resolves them to users in the actor's team scope,
   * and emits a `chat.mention` notification for each. Never throws - a
   * mention that can't be resolved is silently skipped so the send always
   * succeeds. This is the "loop the manager and other staff" mechanism.
   *
   * T-TEAM-AUTHORITATIVE (2026-09-13) multi-team scoping, deliberately
   * bounded by the `TeamMember` RLS SELECT policy's read boundary
   * (policies.sql: "intentionally non-recursive... does NOT let an
   * ordinary team member see who else is on their team via this policy
   * alone"). Concretely:
   *   - MANAGER: resolves across EVERY team they manage (multi-team fix -
   *     `TeamAccessService.getManagedTeamIds` is RLS-safe here because the
   *     TeamMember policy's `Team.managerId` EXISTS clause already grants a
   *     manager visibility into every membership row on teams they lead,
   *     regardless of whose row it is).
   *   - ADMIN/OWNER and ordinary staff (TELECALLER/SALES_EXEC): org-wide.
   *     T-TEAM-AUTHORITATIVE clean cutover (2026-09-13, follow-up): the
   *     legacy `User.teamId`/`actor.teamId` JWT claim this used to filter
   *     ordinary staff by is retired entirely - a `TeamMember`-based
   *     lookup can't replace it (RLS only lets a non-manager read their
   *     OWN membership row, never a teammate's, by the same non-recursive
   *     policy decision above), so ordinary staff now resolve mentions
   *     org-wide too. This is a deliberate, honest scope widening (not a
   *     silently-reversed security decision): @mention was already
   *     best-effort and INTERNAL-note-only (never reaches the customer),
   *     and an org-wide name match is a reasonable floor once no narrower
   *     signal exists.
   *
   * Room for future change: a targeted mention (recipientId) can be added
   * here without touching the Message model - the resolution already
   * produces the recipient's userId.
   */
  private async emitMentions(
    tx: unknown,
    actor: JwtPayload,
    dto: SendMessageDto,
    messageId: string,
  ): Promise<void> {
    if (this.notifications === undefined) return;
    const names = extractMentionedNames(dto.body);
    if (names.length === 0) return;

    const client = tx as unknown as PrismaClient;

    let teamFilter: Record<string, unknown> = {};
    if (actor.role === 'MANAGER') {
      const managedTeamIds = await this.teamAccess.getManagedTeamIds(tx as never, actor.sub);
      // A manager with no managed team (config error) resolves nobody,
      // same as the pre-existing "no team, no mentions" behavior.
      if (managedTeamIds.length === 0) {
        teamFilter = { id: '__none__' };
      } else {
        teamFilter = {
          OR: [
            { teamMemberships: { some: { teamId: { in: managedTeamIds } } } },
            { managedTeams: { some: { id: { in: managedTeamIds } } } },
          ],
        };
      }
    }
    // ADMIN/OWNER and ordinary staff: no team filter (org-wide) - see the
    // doc comment above for why staff can no longer be narrowed further.

    const mentioned = await client.user.findMany({
      where: {
        name: { in: names },
        organizationId: actor.organizationId,
        ...teamFilter,
      },
      select: { id: true, name: true },
    });

    for (const user of mentioned) {
      if (user.id === actor.sub) continue; // don't notify yourself
      await this.notifications.emit(user.id, {
        type: 'chat.mention',
        title: `${actorRowName(actor)} mentioned you`,
        body: `In a note on lead ${dto.leadId}: ${dto.body.slice(0, 100)}`,
        leadId: dto.leadId,
      });
    }
  }
}

/** Pull a display name for the actor (used in mention notifications). */
function actorRowName(actor: JwtPayload): string {
  return actor.email?.split('@')[0] ?? 'A teammate';
}

/**
 * Extract `@Name` tokens from a message body. Matches `@` followed by a
 * proper-noun name (capitalized words, e.g. "Asha T."), stopping at the
 * next `@` or a lowercase word (so "loop @Asha T. and @Ravi" yields
 * ["Asha T.", "Ravi"]). The mention picker inserts `@Name ` with the
 * exact DB name, which is capitalized - this heuristic matches that.
 */
export function extractMentionedNames(body: string): string[] {
  const matches = body.match(/@([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*)/g) ?? [];
  return matches
    .map((m) => m.slice(1).trim())
    .filter((n) => n.length > 0);
}
