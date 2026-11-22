// Inbound chat notifications - tell the lead's owner (and co-owner) that the
// customer wrote something, in the inbox and on their phone.
//
// WHY THIS EXISTS (2026-11-23, owner instruction). Until now an inbound
// WhatsApp message created the Message row and nothing else: the only people
// who learned about it were those already looking at that lead, because the SSE
// stream invalidates the chat query for an open pane. Everyone else found out
// when they happened to open the lead. The reply rate died of that gap.
//
// IN-APP + PUSH IN ONE CALL. NotificationsService.emit() writes the row that the
// bell and /api/sse/notifications read AND fires the web push, so this service
// never touches either surface directly.
//
// ONE ROW PER LEAD PER RECIPIENT WHILE IT IS UNREAD. A customer sending five
// messages in two minutes must not produce five pushes and five inbox rows; the
// existing unread row is refreshed with the newest text instead. Once it is
// read, the next message creates a fresh row, so the badge cannot get stuck
// quiet. This mirrors how overdue alerts throttle themselves rather than adding
// a column and a migration for it.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { withRlsContext } from '@shadhil/database';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.module';

/** Notification type. Not a `chat.mention` - that one is staff-to-staff. */
export const INBOUND_CHAT_NOTIFICATION_TYPE = 'chat.message';

/** Preview length in the bell and on the lock screen. */
export const INBOUND_PREVIEW_MAX = 120;

/**
 * What the notification says, from whatever the message actually carried.
 *
 * An image arrives with an EMPTY body, so without this the notification read
 * "New message from Priya Sharma" followed by nothing at all. Every media kind
 * gets words, and a document keeps its filename because that is the only way a
 * recipient knows whether it matters.
 */
export function inboundPreview(input: {
  body: string;
  mediaKind?: string | null;
  mimeType?: string | null;
  filename?: string | null;
}): string {
  const text = input.body.trim();
  if (text.length > 0) {
    return text.length > INBOUND_PREVIEW_MAX
      ? `${text.slice(0, INBOUND_PREVIEW_MAX - 3)}...`
      : text;
  }
  const kind = input.mediaKind ?? mimeTypeToKind(input.mimeType ?? null);
  switch (kind) {
    case 'image':
      return 'Sent a photo';
    case 'video':
      return 'Sent a video';
    case 'audio':
      return 'Sent a voice note';
    case 'document': {
      const name = input.filename?.trim();
      return name !== undefined && name.length > 0 ? `Sent a document: ${name}` : 'Sent a document';
    }
    default:
      return 'Sent a message';
  }
}

/** Meta's storage layer hands back a mime type, not the message's own kind. */
function mimeTypeToKind(mimeType: string | null): string | null {
  if (mimeType === null) return null;
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

@Injectable()
export class InboundChatNotifierService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    // @Optional() (rule 7h): the inbox is best-effort. Unit tests construct
    // this with a mock; a missing service must never block the webhook ack.
    @Optional()
    @Inject(NotificationsService)
    private readonly notifications?: NotificationsService,
  ) {}

  async notifyInbound(params: {
    organizationId: string;
    /** Written to Notification.projectId so the inbox can filter directly. */
    projectId: string;
    leadId: string;
    leadName: string | null;
    /** Lead.ownerId and Lead.coOwnerId, in that order, as read from the lead. */
    recipientSubs: ReadonlyArray<string | null | undefined>;
    body: string;
    mediaKind?: string | null;
    mimeType?: string | null;
    filename?: string | null;
  }): Promise<void> {
    if (this.notifications === undefined) return;
    // Owner and co-owner may be the same person (or co-owner unset). One row
    // each, never two for the same human.
    const recipients = Array.from(
      new Set(
        params.recipientSubs.filter(
          (sub): sub is string => typeof sub === 'string' && sub.trim().length > 0,
        ),
      ),
    );
    if (recipients.length === 0) return;

    const title = `New message from ${params.leadName ?? 'a lead'}`;
    const body = inboundPreview({
      body: params.body,
      mediaKind: params.mediaKind ?? null,
      mimeType: params.mimeType ?? null,
      filename: params.filename ?? null,
    });

    for (const sub of recipients) {
      try {
        const existing = await this.unreadRowId(sub, params.organizationId, params.leadId);
        if (existing === null) {
          await this.notifications.emit(sub, {
            type: INBOUND_CHAT_NOTIFICATION_TYPE,
            title,
            body,
            leadId: params.leadId,
            projectId: params.projectId,
            organizationId: params.organizationId,
          });
          continue;
        }
        await this.refresh(existing, sub, params.organizationId, title, body);
      } catch {
        // A notification failure must never turn a delivered message into a
        // webhook error: Meta would retry the whole event.
      }
    }
  }

  /** The unread row this recipient already has for this lead, if any. */
  private async unreadRowId(
    recipientSub: string,
    organizationId: string,
    leadId: string,
  ): Promise<string | null> {
    const row = await withRlsContext(
      this.prismaService.$client,
      // Same context emit() uses: the Notification policies are owner-only, so
      // the role is irrelevant and userId is the gate.
      { userId: recipientSub, role: 'TELECALLER', organizationId },
      (tx) =>
        tx.notification.findFirst({
          where: {
            userId: recipientSub,
            type: INBOUND_CHAT_NOTIFICATION_TYPE,
            leadId,
            read: false,
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        }),
    );
    return row?.id ?? null;
  }

  /**
   * Fold the newest message into the row the recipient has not read yet.
   *
   * `createdAt` is bumped so the row rises to the top of the bell: the reader's
   * cue is "this is the latest", and a row that stays at its first message's
   * position would quietly sink under newer, unrelated notifications.
   */
  private async refresh(
    id: string,
    recipientSub: string,
    organizationId: string,
    title: string,
    body: string,
  ): Promise<void> {
    await withRlsContext(
      this.prismaService.$client,
      { userId: recipientSub, role: 'TELECALLER', organizationId },
      (tx) =>
        tx.notification.update({
          where: { id },
          data: { title, body, createdAt: new Date() },
        }),
    );
  }
}
