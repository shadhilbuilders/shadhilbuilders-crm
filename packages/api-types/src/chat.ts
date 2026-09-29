// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Chat module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Used by the in-app chat pane and the WhatsApp inbound webhook handler.
// SSE resume (eng review A9) replays from Message.id so clients can reconnect
// with Last-Event-ID.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import {
  MessageChannelSchema,
  MessageDirectionSchema,
  MessageKindSchema,
} from './enums';

/**
 * POST /api/chat/send - staff sends a message to a lead.
 * Channel defaults to IN_APP; the WhatsApp path is auto-routed by the message
 * service if the lead has consented and the channel is unset.
 * `kind` defaults to CUSTOMER. INTERNAL = staff-only note (never enqueues
 * WhatsApp; the customer never sees it).
 */
export const SendMessageDtoSchema = z.object({
  leadId: z.string().cuid2(),
  body: z.string().trim().min(1).max(4000),
  channel: MessageChannelSchema.optional(),
  kind: MessageKindSchema.optional(),
  mediaUrl: z.string().url().optional(),
  // MEDIA (2026-09-17): staff attachment metadata. The browser uploads the
  // file via POST /api/media (returns a storage key) then sends the key
  // here. mediaKey is the storage key (rendered as the Message.mediaUrl);
  // mediaMimeType + mediaFilename drive the Meta media upload for outbound.
  mediaKey: z.string().min(1).max(500).optional(),
  mediaMimeType: z.string().min(1).max(120).optional(),
  mediaFilename: z.string().min(1).max(255).optional(),
  /**
   * T-MENTION-TARGET (2026-09-29): the ADDRESSED recipients of this note, as
   * resolved by the composer's `@` picker.
   *
   * User IDS, not names. The previous implementation re-parsed `@Name` out of
   * the body and matched `User.name`, which is why a mention could land on a
   * stranger with the same display name anywhere in the organization. The pane
   * already knows which row was clicked, so the identity travels with the
   * request and no name-matching happens on the server.
   *
   * Validated as cuid2 because every User.id is a cuid; a client bug that sends
   * a display name here fails loudly instead of silently addressing nobody.
   */
  mentionedUserIds: z.array(z.string().cuid2()).max(25).optional(),
});
export type SendMessageDto = z.infer<typeof SendMessageDtoSchema>;

/**
 * GET /api/chat/:leadId query - load message history.
 * `since` is a cursor (createdAt ISO) for incremental load.
 * `kind` filters to a single thread (default: CUSTOMER).
 */
export const MessageFilterDtoSchema = z.object({
  leadId: z.string().cuid2(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  kind: MessageKindSchema.optional(),
});
export type MessageFilterDto = z.infer<typeof MessageFilterDtoSchema>;

/**
 * GET /api/chat/:leadId/state - the composer's gating state for one lead.
 *
 * WHY THIS EXISTS. Meta only accepts a FREEFORM reply inside the 24h
 * customer-service window, and the window is opened ONLY by the customer's own
 * inbound message - Meta's docs: "When a WhatsApp user messages you or calls
 * you, a 24-hour timer called a customer service window starts". A
 * business-initiated template does NOT open it.
 *
 * So the pane cannot infer "can I type?" from "did I send something?"; it needs
 * the customer's last inbound. That timestamp is per-thread and was previously
 * only computed inside the WhatsApp-inbox conversations query, so the lead
 * detail pane had no way to know its own window state.
 */
export const ChatThreadStateSchema = z.object({
  leadId: z.string(),
  /** The customer's last inbound message. null = they have never written. */
  lastInboundAt: z.string().datetime({ offset: true }).nullable(),
  /** When this thread was last sent a business-initiated template (null = never). */
  lastTemplateSentAt: z.string().datetime({ offset: true }).nullable(),
  /** True only while Meta will accept a freeform reply. */
  windowOpen: z.boolean(),
  /** When the window closes; null when it has never been opened. */
  windowExpiresAt: z.string().datetime({ offset: true }).nullable(),
  /**
   * T-READONLY-READER (2026-09-29): may this actor WRITE to this lead's thread?
   *
   * Mirrors the `message_insert_team` RLS policy exactly. Needed because the two
   * capabilities came apart: an @mention GRANTS READ of the lead and its whole
   * thread but NOT write. Without this flag the pane rendered a fully working
   * composer for a mentioned teammate, and their reply failed on the RLS insert
   * with a 42501 surfaced as a generic error - the app inviting an action it
   * would refuse.
   *
   * Computed SERVER-side (a client cannot evaluate an RLS policy) and verified
   * against that policy by a live role-by-role probe.
   */
  canWriteThread: z.boolean(),
});
export type ChatThreadState = z.infer<typeof ChatThreadStateSchema>;

/**
 * POST /api/chat/welcome - send the approved WELCOME template to a lead.
 *
 * This is the only compliant way to contact a lead who has gone quiet: a
 * business may always send an approved TEMPLATE, whereas a freeform message
 * requires an open window. Used by the "Welcome Message" button on a thread
 * with no conversation yet.
 */
export const SendWelcomeMessageDtoSchema = z.object({
  leadId: z.string().cuid2(),
});
export type SendWelcomeMessageDto = z.infer<typeof SendWelcomeMessageDtoSchema>;

/**
 * The 24h customer-service window, defined ONCE.
 *
 * Both the server-side send guard and the client composer gate use these, so a
 * change to the rule cannot leave the UI offering a send the API refuses (or
 * worse: the API accepting a send Meta will reject with 131047).
 */
export const WHATSAPP_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Is Meta's customer-service window open for this thread?
 *
 * `lastInboundAt === null` (the customer has never written) is CLOSED: there is
 * no window to reply into, no matter how recently the business sent something.
 * An unparseable timestamp is also closed - fail closed, because the failure
 * mode of guessing wrong is a message the customer never receives.
 */
export function isServiceWindowOpen(
  lastInboundAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  const expiresAt = serviceWindowExpiry(lastInboundAt);
  if (expiresAt === null) return false;
  return expiresAt.getTime() > now.getTime();
}

/** When the window closes, or null if it was never opened / is unparseable. */
export function serviceWindowExpiry(
  lastInboundAt: string | Date | null | undefined,
): Date | null {
  if (lastInboundAt === null || lastInboundAt === undefined) return null;
  const last =
    lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt);
  if (Number.isNaN(last.getTime())) return null;
  return new Date(last.getTime() + WHATSAPP_SERVICE_WINDOW_MS);
}

/** The single wording for a closed window, so server and client agree. */
export const CLOSED_WINDOW_MESSAGE =
  'The 24-hour WhatsApp reply window has closed. Meta only delivers a freeform ' +
  'reply within 24h of the customer\u2019s last message, so this message cannot ' +
  'be sent until they write again.';

/** Explanation shown after a welcome template goes out (window still closed). */
export const AWAITING_CUSTOMER_REPLY_MESSAGE =
  'Welcome message sent. The 24-hour reply window opens when the customer ' +
  'replies, so you can message them freely from then.';

/**
 * Internal shape of a Message row as serialized to the SSE client.
 * `id` is the SSE event-id (eng review A9 - Last-Event-ID resume).
 */
export const MessageEventSchema = z.object({
  id: z.string().cuid2(),
  // T-WA-INBOX (2026-09-25): exactly one thread is set. A message on a
  // known customer carries leadId; one on a not-yet-converted number
  // carries contactId. The chat pane renders both identically.
  leadId: z.string().cuid2().nullable(),
  contactId: z.string().nullable(),
  direction: MessageDirectionSchema,
  channel: MessageChannelSchema,
  kind: MessageKindSchema.optional(),
  body: z.string(),
  mediaUrl: z.string().url().nullable().optional(),
  // MEDIA (2026-09-17): attachment metadata surfaced to the web pane so it
  // can render images inline vs documents as a download link.
  mediaType: z.string().nullable().optional(),
  mediaFilename: z.string().nullable().optional(),
  // Display name of the sender. OUT = the staff member who sent it
  // (Message.user.name); IN = the customer (the lead's name). Null when
  // the sender can't be resolved (e.g. a deleted user). The chat pane
  // renders this in the MessageHeader.
  senderName: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  /**
   * T-MENTION-TARGET (2026-09-29): user ids explicitly @mentioned in this
   * note, so the pane can highlight `@you`. Only INTERNAL notes carry these.
   */
  mentionedUserIds: z.array(z.string()).optional(),
});
export type MessageEvent = z.infer<typeof MessageEventSchema>;


// ────────────────────────────────────────────────────────────────────────────
// WhatsApp inbox (T-WA-INBOX, 2026-09-25)
// ────────────────────────────────────────────────────────────────────────────
//
// The inbox lists EVERY WhatsApp thread for a manager/admin/owner: known-lead
// threads and not-yet-converted numbers, side by side, so staff can read and
// reply from one chat window. A thread is identified by a `threadKey` rather
// than a lead id, because half the threads have no lead.

/** Which kind of thread a row/selection refers to. */
export const ChatThreadKindSchema = z.enum(['LEAD', 'CONTACT']);
export type ChatThreadKind = z.infer<typeof ChatThreadKindSchema>;

/**
 * GET /api/chat/conversations row - one WhatsApp conversation.
 *
 * `displayName` already encodes the product rule: a number that IS linked to a
 * lead shows the lead's name (with the number secondary); a number that is NOT
 * in the lead records shows the number alone.
 */
export const ChatConversationRowSchema = z.object({
  threadKind: ChatThreadKindSchema,
  /** The leadId or contactId - identifies the thread to open. */
  threadId: z.string(),
  /** Stable composite key for React lists: `LEAD:<id>` / `CONTACT:<id>`. */
  threadKey: z.string(),
  /** Lead name when the number is linked to a lead, else the phone number. */
  displayName: z.string(),
  /** Always the E.164 phone, shown as a subtitle in the list. */
  phoneE164: z.string(),
  /** Set when this contact thread is already linked to a lead by phone. */
  linkedLeadId: z.string().nullable(),
  /** Project name for a lead thread; null for a contact thread. */
  projectName: z.string().nullable(),
  /** Last message body ('' when the last item was media-only). */
  lastMessageBody: z.string(),
  /** IN = the customer spoke last, OUT = we spoke last. */
  lastMessageDirection: MessageDirectionSchema,
  /** When the last message landed - drives list ordering. */
  lastMessageAt: z.string().datetime({ offset: true }),
  /**
   * Most recent INBOUND timestamp. Null when the customer has never written.
   * Drives the 24h WhatsApp reply-window indicator: Meta only accepts a
   * freeform reply within 24h of this, and outside it a send would fail.
   */
  lastInboundAt: z.string().datetime({ offset: true }).nullable(),
  /** Unread for the REQUESTING user only (per-user read state). */
  unreadCount: z.number().int().min(0),
});
export type ChatConversationRow = z.infer<typeof ChatConversationRowSchema>;

/** GET /api/chat/conversations filter (server-side, per the repo convention).
 *
 *  limit/offset use z.coerce because QUERY STRINGS always arrive as strings -
 *  a plain z.number() rejects "50" with "expected number, received string",
 *  which 400s every request that passes a limit. That is exactly what the
 *  inbox page did (it always sends limit=50), so the list rendered empty while
 *  the endpoint looked healthy when called with no params.
 */
export const ChatConversationsQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  /** Narrow to one thread kind. Omitted = both. */
  kind: ChatThreadKindSchema.optional(),
  /** Unread-only view.
   *
   *  NOT z.coerce.boolean(): Boolean("false") is true, so `?unreadOnly=false`
   *  would silently mean "unread only" - the opposite of what the caller
   *  asked for. Accept the two literal strings (and a real boolean for
   *  direct/in-process callers) and reject anything else.
   */
  unreadOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ChatConversationsQuery = z.infer<typeof ChatConversationsQuerySchema>;

export const ChatConversationsResultSchema = z.object({
  rows: z.array(ChatConversationRowSchema),
  total: z.number().int().min(0),
  /** Total unread across ALL threads for this user (drives the nav badge). */
  totalUnread: z.number().int().min(0),
});
export type ChatConversationsResult = z.infer<typeof ChatConversationsResultSchema>;

/**
 * POST /api/chat/send for a CONTACT thread. Mirrors SendMessageDto but
 * identifies the thread by contactId instead of leadId.
 */
export const SendContactMessageDtoSchema = z.object({
  contactId: z.string().min(1).max(60),
  body: z.string().trim().min(1).max(4000),
  mediaKey: z.string().min(1).max(500).optional(),
  mediaMimeType: z.string().min(1).max(120).optional(),
  mediaFilename: z.string().min(1).max(255).optional(),
});
export type SendContactMessageDto = z.infer<typeof SendContactMessageDtoSchema>;

/** POST /api/chat/read - mark a thread read up to now for the current user. */
export const MarkChatReadDtoSchema = z
  .object({
    leadId: z.string().cuid2().optional(),
    contactId: z.string().min(1).max(60).optional(),
  })
  .refine(
    (v) => (v.leadId === undefined) !== (v.contactId === undefined),
    { message: 'Provide exactly one of leadId or contactId' },
  );
export type MarkChatReadDto = z.infer<typeof MarkChatReadDtoSchema>;
