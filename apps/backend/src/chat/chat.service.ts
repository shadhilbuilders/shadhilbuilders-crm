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
  ChatConversationsQuery,
  ChatConversationsResult,
  SendContactMessageDto,
  MarkChatReadDto,
  ChatThreadState,
  SendWelcomeMessageDto,
} from '@shadhil/api-types';
// T-WA-WINDOW (2026-09-29): Meta's 24h customer-service window is enforced by
// the SAME predicate the composers use, so the UI cannot offer a send the API
// refuses - or, worse, the API accept one Meta will reject with 131047.
import { CLOSED_WINDOW_MESSAGE, isServiceWindowOpen, serviceWindowExpiry } from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';
import { OutboundService } from '../whatsapp/outbound.service';
import { NotificationsService } from '../notifications/notifications.service';
// T-MENTION-TARGET (2026-09-29): the mention picker's scope, reused so the
// server accepts exactly who the UI can offer (see the constructor note).
import { UsersService } from '../users/users.service';
import { STORAGE_PROVIDER } from '../storage/storage.tokens';
import type { StorageProvider } from '../storage/storage.provider';
import { resolveMediaDisplayUrl } from '../storage/media-display';
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
  // T-WA-INBOX (2026-09-25): a message belongs to exactly ONE thread - a Lead
  // or a WhatsappUnknownContact. Exactly one of these is non-null.
  leadId: string | null;
  contactId: string | null;
  direction: 'IN' | 'OUT';
  channel: 'WHATSAPP' | 'IN_APP';
  kind?: 'CUSTOMER' | 'INTERNAL';
  body: string;
  mediaUrl?: string | null | undefined;
  // MEDIA (2026-09-17): attachment metadata for type-aware rendering.
  mediaType?: string | null | undefined;
  mediaFilename?: string | null | undefined;
  // Display name of the sender. OUT = the staff member (Message.user.name);
  // IN = the customer (the lead's name). Null when unresolvable.
  senderName: string | null;
  /**
   * T-MENTION-TARGET (2026-09-29): users explicitly @mentioned in this note,
   * so the pane can highlight `@you`. Present only for INTERNAL notes that
   * actually addressed someone.
   */
  mentionedUserIds?: string[];
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
    // MEDIA (2026-09-18): storage is only needed to build the PUBLIC display
    // URL for images (Option A). @Optional() (rule 7h) so existing test
    // factories that construct ChatService with fewer args stay green - when
    // it is absent, media falls back to the authenticated BFF path.
    @Optional()
    @Inject(STORAGE_PROVIDER)
    private readonly storage?: StorageProvider,
    // T-MENTION-TARGET (2026-09-29): the mention picker's OWN scope, reused so
    // the server accepts exactly who the UI can offer. @Optional() (rule 7h)
    // for the existing test factories that construct ChatService with fewer
    // args; absent = no extra narrowing beyond the org check.
    //
    // This is the "bounded to the actor's team scope" half of the option-A
    // decision: an @mention grants a lead and its thread, so WHO may be
    // addressed is an authorization boundary, not a UI nicety. Reusing
    // UsersService.teamMembers rather than re-deriving the team rules here is
    // deliberate - a second copy of those rules would drift from the picker,
    // and the failure mode of drift is either a rejected legitimate mention or
    // an offered teammate the server refuses.
    @Optional()
    @Inject(UsersService)
    private readonly users?: UsersService,
  ) {}

  /**
   * Display URL for an attachment row (Option A: images go straight to the
   * provider CDN, documents stay on the authenticated BFF path).
   *
   * Prefers the provider-neutral `mediaKey`; falls back to the row's stored
   * `mediaUrl` so rows written before mediaKey existed still render. See
   * storage/media-display.ts for the policy and the ImageKit -> R2 seam.
   */
  private displayMediaUrl(row: {
    mediaKey?: string | null;
    mediaType?: string | null;
    mediaUrl?: string | null;
  }): string | null {
    const directUrl =
      row.mediaKey !== null && row.mediaKey !== undefined && this.storage?.publicUrl !== undefined
        ? this.storage.publicUrl(row.mediaKey)
        : null;
    return (
      resolveMediaDisplayUrl({
        mediaKey: row.mediaKey,
        mediaType: row.mediaType,
        directUrl,
        storedUrl: row.mediaUrl,
      })?.url ?? null
    );
  }

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * GET /api/chat/:leadId/state - everything the composer needs to gate itself.
   *
   * Computed in ONE place on the server rather than inferred in the pane, because
   * the rule decides whether a message reaches the customer:
   *
   *   - `lastInboundAt`: the customer's last inbound message. THIS is what opens
   *     Meta's 24h window (Meta: "When a WhatsApp user messages you or calls
   *     you, a 24-hour timer called a customer service window starts"). It was
   *     previously computed only inside the WhatsApp-inbox conversations query,
   *     so the lead pane had no way to know its own window state.
   *   - `lastTemplateSentAt`: when this thread was last sent a business-initiated
   *     template, so the pane can say "welcome sent, waiting for them" instead of
   *     offering the button again.
   *   - `windowOpen` / `windowExpiresAt`: derived from the shared predicate.
   *
   * OUTBOUND is the discriminator for inbound: the customer's messages are the
   * ones with direction IN (a Message row with userId=null is inbound from the
   * customer - see the WhatsApp webhook).
   */
  async threadState(actor: JwtPayload, leadId: string): Promise<ChatThreadState> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;
      // RLS-scoped: a lead the actor cannot see resolves null and is reported as
      // not-found rather than silently returning an empty state.
      const lead = await client.lead.findUnique({
        where: { id: leadId },
        // owner/coOwner/team are what the WRITE rule is expressed in, so they
        // are read here to answer canWriteThread (the mention grant is read-only).
        select: {
          id: true,
          ownerId: true,
          coOwnerId: true,
          team: { select: { managerId: true } },
        },
      });
      if (lead === null) {
        throw new NotFoundException(`Lead ${leadId} not found`);
      }

      const [lastInbound, lastTemplate] = await Promise.all([
        client.message.findFirst({
          where: { leadId, direction: 'IN' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        client.outboundMessage.findFirst({
          where: { leadId, sendType: 'TEMPLATE' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      ]);

      const expiry = serviceWindowExpiry(lastInbound?.createdAt ?? null);
      return {
        leadId,
        lastInboundAt: lastInbound?.createdAt.toISOString() ?? null,
        lastTemplateSentAt: lastTemplate?.createdAt.toISOString() ?? null,
        windowOpen: isServiceWindowOpen(lastInbound?.createdAt ?? null),
        windowExpiresAt: expiry?.toISOString() ?? null,
        canWriteThread: canWriteLeadThread(actor, lead),
      };
    });
  }

  /**
   * POST /api/chat/welcome - send the approved WELCOME template to a lead.
   *
   * The ONLY compliant way to contact a lead who has gone quiet: a business may
   * always send an approved TEMPLATE, whereas freeform text requires an open
   * window. So this path deliberately does NOT check the window - the whole point
   * is to reach someone whose window is shut.
   *
   * It writes a Message row (so the outreach appears in the thread the customer
   * will eventually reply into) and an OutboundMessage row with sendType
   * TEMPLATE for the cron to deliver. The template NAME comes from env
   * (`WA_TEMPLATE_WELCOME`) rather than a literal, because a hardcoded name that
   * Meta has not approved fails every send with 132001 - which is exactly how
   * `shadhil_chat_reply` came to be referenced in this codebase but never exist.
   *
   * NOTE: this does NOT open the reply window. Nothing the business sends can -
   * only the customer's own reply does.
   */
  async sendWelcome(actor: JwtPayload, dto: SendWelcomeMessageDto): Promise<{ ok: true; templateName: string }> {
    const templateName = process.env['WA_TEMPLATE_WELCOME'] ?? '';
    if (templateName.length === 0) {
      // Loud, actionable: an operator clicking the button before the template is
      // configured should hear exactly what is missing, not see a generic 500.
      throw new BadRequestException(
        'The welcome template is not configured. Set WA_TEMPLATE_WELCOME to the name of an approved Meta template.',
      );
    }

    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;
      const lead = await client.lead.findUnique({
        where: { id: dto.leadId },
        select: { id: true, name: true, phoneE164: true, phone: true },
      });
      if (lead === null) {
        throw new NotFoundException(`Lead ${dto.leadId} not found`);
      }
      const phone = lead.phoneE164 ?? lead.phone;
      if (phone === null || phone.length === 0) {
        throw new BadRequestException(
          'This lead has no WhatsApp number, so a welcome message cannot be sent.',
        );
      }

      // A visible thread entry, so the outreach is part of the conversation the
      // customer's reply will land in. INTERNAL would hide it from the customer
      // thread; CUSTOMER is correct - the customer DOES receive this.
      const firstName = (lead.name ?? '').trim().split(/\s+/)[0] ?? lead.name ?? '';
      const created = await client.message.create({
        data: {
          leadId: dto.leadId,
          organizationId: actor.organizationId,
          userId: actor.sub,
          direction: 'OUT',
          // WHATSAPP: this really does go to the customer's phone, unlike an
          // IN_APP staff reply.
          channel: 'WHATSAPP',
          kind: 'CUSTOMER',
          body: `Welcome message sent (${templateName}).`,
        },
        select: { id: true, leadId: true },
      });

      await this.outbound.enqueue(
        {
          messageId: created.id,
          organizationId: actor.organizationId,
          leadId: created.leadId ?? dto.leadId,
          sendType: 'TEMPLATE',
          templateName,
          // {{1}} = the customer's first name, matching the approved template's
          // declared parameter order. Changing the template's placeholder count
          // in Meta without updating this breaks the send (Cloud API sends body
          // params as an ordered array).
          templateVars: { '1': firstName },
        },
        tx as unknown as PrismaClient,
      );

      await client.auditLog.create({
        data: {
          userId: actor.sub,
          organizationId: actor.organizationId,
          action: 'chat.welcome.send',
          entityType: 'Lead',
          entityId: dto.leadId,
          after: { templateName },
          reason: `Welcome template "${templateName}" queued for lead ${dto.leadId} by ${actor.email} (${actor.role})`,
        },
      });

      return { ok: true as const, templateName };
    });
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
            contactId: true,
            direction: true,
            channel: true,
            kind: true,
            body: true,
            mediaUrl: true,
            mediaKey: true,
            mediaType: true,
            mediaFilename: true,
            createdAt: true,
            user: { select: { name: true } },
            // T-MENTION-TARGET: the addressed recipients, so the pane can show
            // who a note was directed at and highlight the current user.
            recipients: { select: { userId: true } },
          },
        });

        return rows.map((r) => ({
          id: r.id,
          leadId: r.leadId,
          contactId: r.contactId,
          direction: r.direction,
          channel: r.channel,
          kind: r.kind,
          body: r.body,
          // DERIVED per request (Option A): images resolve to the provider's
          // public CDN URL, documents to the authenticated BFF path. Legacy
          // rows without mediaKey fall back to their stored mediaUrl.
          mediaUrl: this.displayMediaUrl(r),
          mediaType: r.mediaType,
          mediaFilename: r.mediaFilename,
          // OUT → the staff member who sent it; IN → the customer (lead).
          senderName: r.direction === 'OUT' ? (r.user?.name ?? null) : lead.name,
          // Defensive `?? []`: the relation is always selected in production,
          // but a partial test mock must not crash the whole thread render.
          mentionedUserIds: (r.recipients ?? []).map((rc) => rc.userId),
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
          select: { id: true, name: true, phoneE164: true, phone: true },
        });
        if (lead === null) {
          throw new NotFoundException(`Lead ${dto.leadId} not found`);
        }

        // T-WA-WINDOW (2026-09-29): refuse a customer message Meta will reject.
        //
        // Before this guard the API accepted a freeform reply at ANY time and
        // queued it for the cron; outside the 24h window Meta rejects it with
        // 131047 (re-engagement message) and the OutboundMessage row died as a
        // silent FAILED - the operator saw "sent", the customer received nothing.
        // The UI only gated the whatsapp-chat pane, so the API was the real hole.
        //
        // Enforced for the customer thread only, and only when the message would
        // actually reach the phone: an INTERNAL note never leaves the app, and an
        // IN_APP message on a lead with no WhatsApp number is not a WhatsApp send.
        // Mirrors the OUTBOUND ENQUEUE condition EXACTLY (see the enqueue call
        // below): a customer message reaches WhatsApp when the channel is
        // WHATSAPP, or when it is IN_APP on a lead with a phoneE164. Using
        // `phoneE164 ?? phone` here would have gated leads the enqueue would not
        // even try to send to - the gate must match the thing it protects.
        const resolvedChannel: 'WHATSAPP' | 'IN_APP' = dto.channel ?? 'IN_APP';
        const wouldReachWhatsApp =
          kind === 'CUSTOMER' &&
          (resolvedChannel === 'WHATSAPP' ||
            (resolvedChannel === 'IN_APP' && lead.phoneE164 !== null));
        if (wouldReachWhatsApp) {
          const lastInbound = await (tx as unknown as PrismaClient).message.findFirst({
            where: { leadId: dto.leadId, direction: 'IN' },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          });
          if (!isServiceWindowOpen(lastInbound?.createdAt ?? null)) {
            throw new BadRequestException(
              lastInbound === null
                ? 'This customer has not written yet, so the 24-hour WhatsApp reply window is closed. Send the welcome message first; you can reply freely once they answer.'
                : CLOSED_WINDOW_MESSAGE,
            );
          }
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
            // MEDIA (2026-09-18): store the PROVIDER-NEUTRAL key (canonical)
            // plus a derived display URL for back-compat readers. The display
            // URL is recomputed per request by displayMediaUrl() using the
            // Option A policy (images -> public CDN, docs -> authenticated
            // BFF path), so a storage-provider switch never needs a row
            // migration. `dto.mediaUrl` is honoured when a caller supplies it.
            mediaKey: dto.mediaKey,
            mediaUrl:
              dto.mediaUrl ??
              (dto.mediaKey !== undefined ? `/api/bff/media/${encodeURIComponent(dto.mediaKey)}` : undefined),
            mediaType: dto.mediaMimeType,
            mediaFilename: dto.mediaFilename,
          },
          select: {
            id: true,
            leadId: true,
            contactId: true,
            direction: true,
            channel: true,
            kind: true,
            body: true,
            mediaUrl: true,
            mediaKey: true,
            mediaType: true,
            mediaFilename: true,
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
        } else if (
          created.channel === 'WHATSAPP' ||
          (created.channel === 'IN_APP' && lead.phoneE164 !== null)
        ) {
          // OUTBOUND-WA (2026-09-17): a staff CUSTOMER reply reaches the
          // customer on WhatsApp whenever the lead has a reachable WhatsApp
          // number AND the chat is the customer thread - regardless of the
          // display channel. The pane sends channel='IN_APP' (the row renders
          // in the panel), but the customer should still receive the reply on
          // WhatsApp within the 24h window (shadhil_chat_reply is a UTILITY
          // template; this is a true reply to the customer's inbound, compliant).
          // INTERNAL is hard-excluded above (staff-only note, never leaks to
          // the phone). Enqueueing is inside withRlsContext so the
          // OutboundMessage INSERT has app.user_id (outbound_insert_authenticated)
          // and the cron drains it via CRON_SERVICE.
          const firstName = (lead.name ?? '').trim().split(/\s+/)[0] ?? lead.name ?? '';

          // T-E2b: if the channel is WHATSAPP / IN_APP-with-phone, enqueue an
          // outbound. We do this INSIDE the withRlsContext block so
          // the OutboundMessage INSERT runs under the actor's RLS
          // (the outbound_insert_authenticated policy requires
          // app.user_id to be set, which the bare client can't
          // provide). The cron processor later picks it up via the
          // CRON_SERVICE role.
          const body = created.body.length > 1000 ? created.body.slice(0, 1000) : created.body;
          await this.outbound.enqueue(
            {
              messageId: created.id,
              organizationId: actor.organizationId,
              // A CUSTOMER send is always on a known-lead thread here, so
              // leadId is present; narrow it rather than passing null.
              leadId: created.leadId ?? dto.leadId,
              // FREEFORM, not TEMPLATE: this is a reply inside the 24h
              // customer-service window, so Meta accepts plain text with
              // NO approved template. Using shadhil_chat_reply failed with
              // 132001 "template does not exist" because the template is
              // never created in Meta. A text reply avoids templates entirely
              // and costs nothing within the window.
              sendType: 'FREEFORM',
              freeformBody: body,
              // MEDIA (2026-09-17): when the DTO carries an attachment,
              // persist the metadata so the cron sends the file (instead of
              // only text). mediaUrl is the storage key for the Message row;
              // the media* fields come from the same upload.
              ...(dto.mediaKey !== undefined ? { mediaKey: dto.mediaKey } : {}),
              ...(dto.mediaMimeType !== undefined ? { mediaType: dto.mediaMimeType } : {}),
              ...(dto.mediaFilename !== undefined ? { mediaFilename: dto.mediaFilename } : {}),
            },
            // Pass the RLS-scoped tx so the OutboundMessage INSERT runs on
            // the same connection that carries app.user_id (set by
            // withRlsContext). Without the override, enqueue inserts on the
            // bare injected client → app.user_id unset → 42501 policy
            // violation (outbound_insert_authenticated).
            tx as unknown as PrismaClient,
          );
        }

        return {
          id: created.id,
          leadId: created.leadId,
          contactId: created.contactId,
          direction: created.direction,
          channel: created.channel,
          kind: created.kind,
          body: created.body,
          // Same derivation as list() so the optimistic/returned row matches
          // what a refetch will show (images -> public CDN under Option A).
          mediaUrl: this.displayMediaUrl(created),
          mediaType: created.mediaType,
          mediaFilename: created.mediaFilename,
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
  // ──────────────────────────────────────────────────────────────────────────
  // WhatsApp inbox (T-WA-INBOX, 2026-09-25)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * GET /api/chat/conversations - every WhatsApp thread this actor may see,
   * newest activity first. Covers BOTH thread types:
   *
   *   LEAD    - a known customer (the thread the lead detail page already shows)
   *   CONTACT - an unknown number that has not been converted to a lead yet
   *
   * Unread is per-USER: a thread is unread when its last inbound is newer than
   * THIS user's ChatReadState.lastReadAt. Three managers sharing a thread each
   * keep their own badge.
   *
   * Implemented in raw SQL for one reason: the list must be ordered by a
   * computed "last message at" across two thread columns with a per-user
   * unread sub-count, which Prisma's typed query cannot express without N+1
   * round trips. Every predicate is parameterised; the RLS policies still
   * apply (the actor's GUCs are set by withRlsContext), so this cannot widen
   * visibility beyond what the policies allow.
   */
  async conversations(
    actor: JwtPayload,
    dto: ChatConversationsQuery,
  ): Promise<ChatConversationsResult> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const search = dto.search?.trim();
      const searchLike = search !== undefined && search.length > 0 ? `%${search}%` : null;

      // The UNION builds one row per thread with a common shape, then the
      // outer query applies search / kind / unread filters and paging. Doing
      // the filters out here (rather than inside each branch) keeps the two
      // branches symmetric and the LIMIT honest.
      const rows = await (tx as unknown as PrismaClient).$queryRawUnsafe<
        Array<{
          thread_kind: string;
          thread_id: string;
          display_name: string;
          phone_e164: string;
          linked_lead_id: string | null;
          project_name: string | null;
          last_message_body: string;
          last_message_direction: string;
          last_message_at: Date;
          last_inbound_at: Date | null;
          unread_count: bigint | number;
        }>
      >(
        `
        WITH threads AS (
          -- Known-customer threads: one per lead that has WhatsApp traffic.
          SELECT
            'LEAD'                                    AS thread_kind,
            l.id                                      AS thread_id,
            l.name                                    AS display_name,
            COALESCE(l."phoneE164", l.phone)          AS phone_e164,
            l.id                                      AS linked_lead_id,
            p.name                                    AS project_name,
            COALESCE(last_msg.body, '')               AS last_message_body,
            COALESCE(last_msg.direction::text, 'IN')  AS last_message_direction,
            last_msg."createdAt"                      AS last_message_at,
            last_in."createdAt"                       AS last_inbound_at,
            COALESCE(unread.cnt, 0)                   AS unread_count
          FROM "Lead" l
          LEFT JOIN "Project" p ON p.id = l."projectId"
          -- Only leads that actually have WhatsApp traffic belong in a
          -- WhatsApp inbox; a lead with no messages is not a conversation.
          JOIN LATERAL (
            SELECT m.body, m.direction, m."createdAt"
            FROM "Message" m
            WHERE m."leadId" = l.id AND m.channel = 'WHATSAPP' AND m.kind = 'CUSTOMER'
            ORDER BY m."createdAt" DESC
            LIMIT 1
          ) last_msg ON TRUE
          LEFT JOIN LATERAL (
            SELECT m."createdAt"
            FROM "Message" m
            WHERE m."leadId" = l.id AND m.direction = 'IN' AND m.channel = 'WHATSAPP'
            ORDER BY m."createdAt" DESC
            LIMIT 1
          ) last_in ON TRUE
          LEFT JOIN LATERAL (
            SELECT count(*) AS cnt
            FROM "Message" m
            WHERE m."leadId" = l.id
              AND m.direction = 'IN'
              AND m.channel = 'WHATSAPP'
              AND m."createdAt" > COALESCE(
                    (SELECT rs."lastReadAt" FROM "ChatReadState" rs
                     WHERE rs."userId" = $1 AND rs."leadId" = l.id),
                    TIMESTAMP '1970-01-01')
          ) unread ON TRUE

          UNION ALL

          -- Not-yet-converted numbers. A number that is ALREADY linked to a
          -- lead by phone is deliberately EXCLUDED here: it would show the
          -- same conversation twice, once under the lead's name and once under
          -- the bare number. The product rule is "if the number is linked to a
          -- lead, show the lead" - so the lead row above wins.
          SELECT
            'CONTACT'                                 AS thread_kind,
            c.id                                      AS thread_id,
            c."phoneE164"                             AS display_name,
            c."phoneE164"                             AS phone_e164,
            linked.id                                 AS linked_lead_id,
            NULL                                      AS project_name,
            COALESCE(last_msg.body, '')               AS last_message_body,
            COALESCE(last_msg.direction::text, 'IN')  AS last_message_direction,
            last_msg."createdAt"                      AS last_message_at,
            last_in."createdAt"                       AS last_inbound_at,
            COALESCE(unread.cnt, 0)                   AS unread_count
          FROM "WhatsappUnknownContact" c
          LEFT JOIN "Lead" linked ON linked."phoneE164" = c."phoneE164"
          JOIN LATERAL (
            SELECT m.body, m.direction, m."createdAt"
            FROM "Message" m
            WHERE m."contactId" = c.id AND m.channel = 'WHATSAPP'
            ORDER BY m."createdAt" DESC
            LIMIT 1
          ) last_msg ON TRUE
          LEFT JOIN LATERAL (
            SELECT m."createdAt"
            FROM "Message" m
            WHERE m."contactId" = c.id AND m.direction = 'IN'
            ORDER BY m."createdAt" DESC
            LIMIT 1
          ) last_in ON TRUE
          LEFT JOIN LATERAL (
            SELECT count(*) AS cnt
            FROM "Message" m
            WHERE m."contactId" = c.id
              AND m.direction = 'IN'
              AND m."createdAt" > COALESCE(
                    (SELECT rs."lastReadAt" FROM "ChatReadState" rs
                     WHERE rs."userId" = $1 AND rs."contactId" = c.id),
                    TIMESTAMP '1970-01-01')
          ) unread ON TRUE
          WHERE linked.id IS NULL
        )
        SELECT * FROM threads
        WHERE ($2::text IS NULL
               OR display_name ILIKE $2
               OR phone_e164 ILIKE $2)
          AND ($3::text IS NULL OR thread_kind = $3)
          AND ($4::boolean IS NOT TRUE OR unread_count > 0)
        ORDER BY last_message_at DESC
        LIMIT $5 OFFSET $6
        `,
        actor.sub,
        searchLike,
        dto.kind ?? null,
        dto.unreadOnly ?? null,
        dto.limit,
        dto.offset,
      );

      // Unread across ALL the actor's threads (not just this page) so the
      // "N unread" badge is honest regardless of paging or the active filter.
      // Deliberately NOT a message count: `total` below is a thread count, and
      // an unused second aggregate here would only drift from it.
      const totals = await (tx as unknown as PrismaClient).$queryRawUnsafe<
        Array<{ total_unread: bigint | number }>
      >(
        `
        SELECT (
          SELECT count(*) FROM "Message" m
          WHERE m.direction = 'IN' AND m.channel = 'WHATSAPP'
            AND m."createdAt" > COALESCE(
                  (SELECT rs."lastReadAt" FROM "ChatReadState" rs
                   WHERE rs."userId" = $1
                     AND ((m."leadId" IS NOT NULL AND rs."leadId" = m."leadId")
                       OR (m."contactId" IS NOT NULL AND rs."contactId" = m."contactId"))),
                  TIMESTAMP '1970-01-01')
        ) AS total_unread
        `,
        actor.sub,
      );

      const totalRows = totals[0];
      const conversationCount = await (tx as unknown as PrismaClient).$queryRawUnsafe<
        Array<{ cnt: bigint | number }>
      >(
        `SELECT count(*) AS cnt FROM (
           SELECT l.id FROM "Lead" l
             WHERE EXISTS (SELECT 1 FROM "Message" m
                           WHERE m."leadId" = l.id AND m.channel = 'WHATSAPP')
           UNION ALL
           SELECT c.id FROM "WhatsappUnknownContact" c
             WHERE NOT EXISTS (SELECT 1 FROM "Lead" x WHERE x."phoneE164" = c."phoneE164")
               AND EXISTS (SELECT 1 FROM "Message" m WHERE m."contactId" = c.id)
         ) t`,
      );

      return {
        rows: rows.map((r) => {
          const threadKind = r.thread_kind === 'CONTACT' ? 'CONTACT' : 'LEAD';
          return {
            threadKind,
            threadId: r.thread_id,
            threadKey: `${threadKind}:${r.thread_id}`,
            displayName: r.display_name,
            phoneE164: r.phone_e164,
            linkedLeadId: r.linked_lead_id,
            projectName: r.project_name,
            lastMessageBody: r.last_message_body,
            lastMessageDirection: r.last_message_direction === 'OUT' ? 'OUT' : 'IN',
            lastMessageAt: r.last_message_at.toISOString(),
            lastInboundAt: r.last_inbound_at === null ? null : r.last_inbound_at.toISOString(),
            unreadCount: Number(r.unread_count),
          };
        }),
        total: Number(conversationCount[0]?.cnt ?? 0),
        totalUnread: Number(totalRows?.total_unread ?? 0),
      };
    });
  }

  /**
   * List messages on a CONTACT thread. Mirrors list() but keys on contactId;
   * kept as a sibling rather than a branch inside list() so the lead path
   * (which the lead detail page depends on) is not destabilised.
   */
  async listContact(
    actor: JwtPayload,
    contactId: string,
    limit: number,
  ): Promise<MessageListResult> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const contact = await (tx as unknown as PrismaClient).whatsappUnknownContact.findUnique({
        where: { id: contactId },
        select: { id: true },
      });
      if (contact === null) {
        throw new NotFoundException(`Whatsapp contact ${contactId} not found`);
      }

      const rows = await (tx as unknown as PrismaClient).message.findMany({
        where: { contactId },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: {
          id: true,
          leadId: true,
          contactId: true,
          direction: true,
          channel: true,
          kind: true,
          body: true,
          mediaUrl: true,
          mediaKey: true,
          mediaType: true,
          mediaFilename: true,
          createdAt: true,
          user: { select: { name: true } },
        },
      });

      // Resolved ONCE per request, not per row: every inbound message on a
      // contact thread shares the same sender display name.
      const inboundSenderName = await this.contactSenderName(tx, contactId);

      return rows.map((r) => ({
        id: r.id,
        leadId: r.leadId,
        contactId: r.contactId,
        direction: r.direction,
        channel: r.channel,
        kind: r.kind,
        body: r.body,
        mediaUrl: this.displayMediaUrl(r),
        mediaType: r.mediaType,
        mediaFilename: r.mediaFilename,
        // OUT -> the staff member who sent it. IN -> the customer, who on a
        // contact thread has no name until the number is converted, so the
        // phone number stands in (the pane shows it in the MessageHeader).
        senderName:
          r.direction === 'OUT' ? (r.user?.name ?? null) : inboundSenderName,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }

  /** Display name for an inbound contact-thread sender: the lead's name when
   *  the number is already linked to a lead, otherwise the phone number. */
  private async contactSenderName(
    tx: unknown,
    contactId: string,
  ): Promise<string | null> {
    const client = tx as unknown as PrismaClient;
    const contact = await client.whatsappUnknownContact.findUnique({
      where: { id: contactId },
      select: { phoneE164: true, convertedToLeadId: true },
    });
    if (contact === null) return null;
    if (contact.convertedToLeadId !== null) {
      const lead = await client.lead.findUnique({
        where: { id: contact.convertedToLeadId },
        select: { name: true },
      });
      if (lead !== null) return lead.name;
    }
    return contact.phoneE164;
  }

  /**
   * Send a reply on a CONTACT thread. Writes the Message row and enqueues the
   * WhatsApp outbound in ONE transaction, exactly like the lead path, so a
   * reply can never be stored without being sent (or vice versa).
   *
   * A contact thread has no `kind`, so it is always a customer conversation -
   * the INTERNAL-notes concept does not apply here.
   */
  async sendToContact(
    actor: JwtPayload,
    dto: SendContactMessageDto,
  ): Promise<MessageRow> {
    if (dto.body.trim().length === 0) {
      throw new BadRequestException('Message body cannot be empty');
    }
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const contact = await (tx as unknown as PrismaClient).whatsappUnknownContact.findUnique({
        where: { id: dto.contactId },
        select: { id: true, phoneE164: true },
      });
      if (contact === null) {
        throw new NotFoundException(`Whatsapp contact ${dto.contactId} not found`);
      }

      const created = await (tx as unknown as PrismaClient).message.create({
        data: {
          contactId: dto.contactId,
          organizationId: actor.organizationId,
          userId: actor.sub,
          direction: 'OUT',
          channel: 'WHATSAPP',
          kind: 'CUSTOMER',
          body: dto.body,
          mediaKey: dto.mediaKey,
          mediaUrl:
            dto.mediaKey !== undefined
              ? `/api/bff/media/${encodeURIComponent(dto.mediaKey)}`
              : undefined,
          mediaType: dto.mediaMimeType,
          mediaFilename: dto.mediaFilename,
        },
        select: {
          id: true,
          leadId: true,
          contactId: true,
          direction: true,
          channel: true,
          kind: true,
          body: true,
          mediaUrl: true,
          mediaKey: true,
          mediaType: true,
          mediaFilename: true,
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
            contactId: created.contactId,
            direction: created.direction,
            channel: created.channel,
          },
          reason: `WhatsApp reply to unknown contact ${dto.contactId} by ${actor.email} (${actor.role})`,
        },
      });

      // Enqueue the outbound on the same transaction (same RLS connection).
      // FREEFORM because this is a reply inside Meta's 24h customer-service
      // window; outside it Meta rejects the send, which is why the UI warns
      // and blocks before reaching here.
      const outBody = created.body.length > 1000 ? created.body.slice(0, 1000) : created.body;
      await this.outbound.enqueue(
        {
          messageId: created.id,
          organizationId: actor.organizationId,
          contactId: created.contactId as string,
          sendType: 'FREEFORM',
          freeformBody: outBody,
          ...(dto.mediaKey !== undefined ? { mediaKey: dto.mediaKey } : {}),
          ...(dto.mediaMimeType !== undefined ? { mediaType: dto.mediaMimeType } : {}),
          ...(dto.mediaFilename !== undefined ? { mediaFilename: dto.mediaFilename } : {}),
        },
        tx as unknown as PrismaClient,
      );

      return {
        id: created.id,
        leadId: created.leadId,
        contactId: created.contactId,
        direction: created.direction,
        channel: created.channel,
        kind: created.kind,
        body: created.body,
        mediaUrl: this.displayMediaUrl(created),
        mediaType: created.mediaType,
        mediaFilename: created.mediaFilename,
        senderName: null,
        createdAt: created.createdAt.toISOString(),
      };
    });
  }

  /**
   * POST /api/chat/read - move THIS user's read position on a thread to now.
   * Upsert rather than update: the first visit to a thread has no row yet.
   */
  async markRead(actor: JwtPayload, dto: MarkChatReadDto): Promise<{ ok: true }> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;
      const now = new Date();
      if (dto.leadId !== undefined) {
        // The thread must be one this user can actually see; the RLS policy
        // on ChatReadState also enforces userId = app.user_id, so a forged
        // userId cannot be written.
        const existing = await client.chatReadState.findFirst({
          where: { userId: actor.sub, leadId: dto.leadId },
          select: { id: true },
        });
        if (existing === null) {
          await client.chatReadState.create({
            data: {
              userId: actor.sub,
              leadId: dto.leadId,
              lastReadAt: now,
            },
          });
        } else {
          await client.chatReadState.update({
            where: { id: existing.id },
            data: { lastReadAt: now },
          });
        }
        return { ok: true as const };
      }

      const contactId = dto.contactId as string;
      const existing = await client.chatReadState.findFirst({
        where: { userId: actor.sub, contactId },
        select: { id: true },
      });
      if (existing === null) {
        await client.chatReadState.create({
          data: {
            userId: actor.sub,
            contactId,
            lastReadAt: now,
          },
        });
      } else {
        await client.chatReadState.update({
          where: { id: existing.id },
          data: { lastReadAt: now },
        });
      }
      return { ok: true as const };
    });
  }

  /**
   * T-MENTION-TARGET (2026-09-29): write the ADDRESSED recipients of an
   * INTERNAL note and notify each one.
   *
   * Replaces the old name-guessing resolver. That version re-parsed `@Name`
   * from the body, matched it against `User.name` with NO team narrowing for
   * ordinary staff, and put `body.slice(0, 100)` in the notification. Two
   * defects followed, and both are fixed here:
   *
   *   1. A telecaller could surface a lead's internal note to ANY same-named
   *      user in the organization. Identity now comes from the composer's
   *      picked row (`dto.mentionedUserIds`), so a display name can no longer
   *      address a stranger.
   *   2. The mentioned teammate could not open the lead, so the notification
   *      quoted text they had no way to read the rest of or act on. The
   *      `MessageRecipient` row is now an RLS grant (lead + full thread), so
   *      the notification deep-links somewhere the recipient can actually open.
   *
   * Runs INSIDE the caller's transaction, so a note and its grants commit
   * together: a crash cannot leave a note that notifies nobody, or a grant
   * pointing at a message that was never written.
   *
   * Recipients are verified against the actor's own organization here rather
   * than trusted from the payload. RLS on `User` is absent, so this is the
   * check that stops a forged id from another tenant being addressed and
   * granted a lead.
   */
  private async emitMentions(
    tx: unknown,
    actor: JwtPayload,
    dto: SendMessageDto,
    messageId: string,
  ): Promise<void> {
    const requested = dto.mentionedUserIds ?? [];
    if (requested.length === 0) return;

    const client = tx as unknown as PrismaClient;

    // De-duplicate: the same teammate mentioned twice is one recipient (the
    // unique index would reject the second row anyway) and one notification.
    const uniqueIds = Array.from(new Set(requested)).filter(
      (id) => id !== actor.sub, // a self-mention grants nothing; the actor sees the lead already
    );
    if (uniqueIds.length === 0) return;

    const recipients = await client.user.findMany({
      where: { id: { in: uniqueIds }, organizationId: actor.organizationId },
      select: { id: true },
    });
    if (recipients.length === 0) return;

    // "Bounded to the actor's team scope" (option-A decision): only address
    // someone the actor could have picked in the composer. Checked against
    // UsersService.teamMembers - the picker's own source - so the server and
    // the UI cannot disagree about who is addressable.
    let allowed = recipients;
    if (this.users !== undefined) {
      const team = await this.users.teamMembers(actor);
      const allowedIds = new Set(team.map((u) => u.id));
      allowed = recipients.filter((r) => allowedIds.has(r.id));
      if (allowed.length === 0) return;
    }

    await client.messageRecipient.createMany({
      data: allowed.map((r) => ({
        messageId,
        userId: r.id,
        // Denormalized so every policy on this table reads its OWN columns -
        // see the MessageRecipient doc. Without leadId the Lead policy would
        // have to traverse Message, which is the recursion trap.
        leadId: dto.leadId,
        organizationId: actor.organizationId,
      })),
      skipDuplicates: true,
    });

    // Notifications are best-effort (the NotificationsService is @Optional():
    // unit tests run without it). The GRANT above is not best-effort - it is
    // written in the same transaction regardless, so access never depends on a
    // notification succeeding.
    if (this.notifications === undefined) return;
    for (const r of allowed) {
      await this.notifications.emit(r.id, {
        type: 'chat.mention',
        title: `${actorRowName(actor)} mentioned you`,
        // The FULL note, not a 100-char tease. The recipient now has the grant
        // to read it, so truncating a note they are allowed to read only
        // obscures it. (The old truncation existed because they could NOT read
        // it - it leaked a snippet to someone with no access.)
        body: dto.body,
        leadId: dto.leadId,
      });
    }
  }
}

/**
 * T-READONLY-READER (2026-09-29): may this actor WRITE messages on this lead?
 *
 * A deliberate MIRROR of the `message_insert_team` RLS policy:
 *
 *   ADMIN                                        -> yes
 *   MANAGER where lead.team.managerId === actor   -> yes
 *   TELECALLER/SALES_EXEC where ownerId or coOwnerId === actor -> yes
 *   otherwise                                     -> no
 *
 * Why a mirror is acceptable here: RLS stays the ENFORCER - this only decides
 * whether the UI OFFERS the action. If the two ever disagree the write is still
 * refused by the database, so drift costs a confusing UI, never an unauthorised
 * write.
 *
 * It exists because a mention grants READ of the lead and its whole thread
 * WITHOUT granting write, so "can see this" stopped meaning "can reply here".
 * Without it the pane rendered a working composer for a mentioned teammate and
 * their reply died on a 42501 shown as a generic error.
 */
function canWriteLeadThread(
  actor: JwtPayload,
  lead: {
    ownerId: string;
    coOwnerId: string | null;
    team: { managerId: string | null } | null;
  },
): boolean {
  if (actor.role === 'ADMIN' || actor.role === 'OWNER') return true;
  if (actor.role === 'MANAGER') return lead.team?.managerId === actor.sub;
  return lead.ownerId === actor.sub || lead.coOwnerId === actor.sub;
}

/** Pull a display name for the actor (used in mention notifications). */
function actorRowName(actor: JwtPayload): string {
  return actor.email?.split('@')[0] ?? 'A teammate';
}
