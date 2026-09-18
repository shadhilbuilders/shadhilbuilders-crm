'use client';

// LeadChatPane - embedded chat panel on the lead detail page.
//
// Wired to the chat backend (T-CHAT, Pass 1):
//   - useMessages(leadId, kind): GET /api/chat/:leadId?kind= → bare array
//     ordered oldest → newest.
//   - useSendMessage(leadId, kind): POST /api/chat/send → on success,
//     invalidates the messages query (refetch replaces the optimistic
//     row with the server-returned MessageEvent including the real id
//     and timestamp).
//
// Rendered with the @paalstack/react-ui chat primitives (composition
// API, per the shadcn message-scroller group-chat reference):
//   - MessageScrollerProvider/MessageScroller/Viewport/Content/Item/Button
//     own the scroll behavior (auto-scroll to the live edge, scroll-to-end
//     button, visibility tracking).
//   - Message + MessageContent + Bubble render each row. OUT (staff →
//     customer) aligns to the end (right, muted bubble); IN (customer →
//     staff) aligns to the start (left, tinted bubble). The sender name
//     shows in the MessageHeader for incoming messages; the current user's
//     own messages show an avatar + name on the right.
//   - Marker renders the empty-state hint and the date separators.
//
// Polish (autoplan 2026-09-09, workstream A):
//   - Conversation header: lead name + channel + participant avatar.
//   - Date separators (Today / Yesterday / This week / Older) per
//     WIREFRAMES.md:334 / DESIGN.md:708.
//   - Auto-grow textarea composer with Enter-to-send (Shift+Enter = newline).
//   - Designed empty state (icon + copy) instead of a bare text line.
//
// Group chat foundation (autoplan 2026-09-09, workstream B-minimal):
//   - Customer / Internal toggle in the header. Customer = the 1:1
//     staff↔customer thread (unchanged). Internal = staff-only notes on
//     the lead thread (never enqueues WhatsApp; the customer never sees
//     them). Internal messages render with a distinct badge.
//   - @mention picker in the Internal composer: typing `@` opens a popover
//     of the actor's team + manager (GET /api/users/team). Selecting a
//     member inserts `@Name`; the backend resolves it to a chat.mention
//     notification (the "loop the manager" mechanism).
//
// Live updates (SSE) are deferred to Week 7 per the chat plan. For
// now, sending a message invalidates the query → refetch → render.
// Good enough for the demo loop.

import {
  Attachment,
  AttachmentActions,
  AttachmentDescription,
  AttachmentTitle,
  AvatarFallback,
  AvatarRoot,
  Bubble,
  BubbleContent,
  CardContent,
  CardFooter,
  CardRoot,
  Empty,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  Marker,
  MarkerContent,
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  ToggleGroup,
  toast,
} from '@paalstack/react-ui';
import { LuArrowUp, LuFile, LuLock, LuMessageSquare, LuPaperclip, LuRefreshCw, LuX } from '@paalstack/react-icons/lu';
import { useMemo, useRef, useState } from 'react';

import { useMessages, useMessagesRealtime, useSendMessage, uploadChatMedia } from '@/hooks/queries/crm';
import { useTeamMembers } from '@/hooks/queries/users';
import { useProjectId } from '@/lib/tenant-context';
import { dateIntl } from '@/lib/format';
import { useSessionUser } from '@/lib/session';

import { AttachmentImage } from './AttachmentImage';

type Direction = 'IN' | 'OUT';
type Channel = 'WHATSAPP' | 'IN_APP';
type Kind = 'CUSTOMER' | 'INTERNAL';

type MessageRow = {
  id: string;
  leadId?: string;
  direction?: Direction;
  channel?: Channel;
  kind?: Kind;
  body?: string;
  mediaUrl?: string | null;
  // MEDIA (2026-09-17): attachment metadata for type-aware rendering.
  mediaType?: string | null;
  mediaFilename?: string | null;
  senderName?: string | null;
  createdAt?: string;
};

// MEDIA: a file the user has picked in the composer (preview before send).
type PendingAttachment = {
  file: File;
  // Object URL for immediate preview; replaced by the uploaded media URL on
  // successful send (the row then re-renders from the server).
  previewUrl: string;
};

function isMessageDirection(value: unknown): value is Direction {
  return value === 'IN' || value === 'OUT';
}

function formatMessageTime(value: string | undefined): string {
  if (value === undefined) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return dateIntl.formatDateTime(value);
}

/** Initials for the avatar fallback (e.g. "Asha T." → "AT"). */
function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

/** Human-readable byte size for the attachment preview (e.g. "1.2 MB"). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(value >= 10 || exp === 0 ? 0 : 1)} ${units[exp]}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Client-side file validation (mirrors backend MediaController limits)
// ────────────────────────────────────────────────────────────────────────────

/** Maximum upload size in bytes (10MB, matches backend MAX_UPLOAD_BYTES). */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Allowed MIME type prefixes (matches backend ALLOWED_MIME_PREFIXES). */
const ALLOWED_MIME_PREFIXES = ['image/', 'application/pdf', 'text/', 'video/', 'audio/'] as const;

/** Result of validating a file for chat upload. */
type FileValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Validate a file before upload. Returns { ok: true } if valid,
 * or { ok: false, error: 'user-friendly message' } if invalid.
 */
function validateChatFile(file: File): FileValidationResult {
  // Check file size
  if (file.size > MAX_UPLOAD_BYTES) {
    const maxMB = MAX_UPLOAD_BYTES / (1024 * 1024);
    return { ok: false, error: `File is too large. Maximum size is ${maxMB}MB.` };
  }
  if (file.size === 0) {
    return { ok: false, error: 'File is empty.' };
  }

  // Check MIME type
  const mimeType = file.type || 'application/octet-stream';
  const allowed = ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
  if (!allowed) {
    return { ok: false, error: 'Unsupported file type. Allowed: images, PDFs, text files, videos, and audio.' };
  }

  return { ok: true };
}

export { validateChatFile, type FileValidationResult };

// ────────────────────────────────────────────────────────────────────────────
// Date grouping (WIREFRAMES.md:334 / DESIGN.md:708)
//   Today / Yesterday / This week / Older
// A pure function so it's unit-testable without a clock.
// ────────────────────────────────────────────────────────────────────────────

export type DateGroup = 'Today' | 'Yesterday' | 'This week' | 'Older';

/** Bucket a date into a display group relative to `now`. */
export function groupForDate(iso: string | undefined, now: Date = new Date()): DateGroup | null {
  if (iso === undefined) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const startOfDay = (d: Date): number => {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c.getTime();
  };

  const todayStart = startOfDay(now);
  const dateStart = startOfDay(date);
  const dayDiff = Math.round((todayStart - dateStart) / 86_400_000);

  if (dayDiff <= 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';

  // "This week" = same Mon-Sun week as today.
  const dayOfWeek = (d: Date): number => (d.getDay() + 6) % 7; // Mon=0
  const weekStart = todayStart - dayOfWeek(now) * 86_400_000;
  if (dateStart >= weekStart) return 'This week';

  return 'Older';
}

/**
 * Human label for a date separator. Today/Yesterday/This week stay
 * relative (per WIREFRAMES.md:334); anything older shows the actual
 * calendar date so "Older" isn't vague.
 */
export function separatorLabel(iso: string | undefined, now: Date = new Date()): string {
  const group = groupForDate(iso, now);
  if (group === null) return '';
  if (group === 'Older') {
    const date = new Date(iso as string);
    if (!Number.isNaN(date.getTime())) {
      return dateIntl.format(date, 'd MMM yyyy');
    }
  }
  return group;
}

/**
 * Insert a date-separator row before the first message of each group.
 * Returns a flat list of `{ type: 'separator', label } | { type: 'message', row, index }`.
 */
export function withDateSeparators(
  rows: MessageRow[],
  now: Date = new Date(),
): Array<{ type: 'separator'; label: string; group: DateGroup } | { type: 'message'; row: MessageRow; index: number }> {
  const out: Array<{ type: 'separator'; label: string; group: DateGroup } | { type: 'message'; row: MessageRow; index: number }> = [];
  let lastGroup: DateGroup | null = null;
  rows.forEach((row, index) => {
    const group = groupForDate(row.createdAt, now);
    if (group !== null && group !== lastGroup) {
      out.push({ type: 'separator', label: separatorLabel(row.createdAt, now), group });
      lastGroup = group;
    }
    out.push({ type: 'message', row, index });
  });
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Mention parsing (mirrors the backend's extractMentionedNames)
// ────────────────────────────────────────────────────────────────────────────

/** Extract `@Name` tokens from a message body (mirrors the backend). */
export function extractMentionedNames(body: string): string[] {
  const matches = body.match(/@([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*)/g) ?? [];
  return matches
    .map((m) => m.slice(1).trim())
    .filter((n) => n.length > 0);
}

// ────────────────────────────────────────────────────────────────────────────

export function LeadChatPane({
  leadId,
  leadName,
}: {
  leadId: string | null;
  leadName?: string | null;
}) {
  const { user } = useSessionUser();
  const [kind, setKind] = useState<Kind>('CUSTOMER');
  const messagesQuery = useMessages(leadId, kind);
  const sendMessage = useSendMessage(leadId ?? '', kind);
  // T-E2 (Week 6): live message stream - invalidates the chat query
  // whenever a new Message row lands (inbound WhatsApp, another staff
  // member's reply, or the customer's own message). The pane re-renders
  // from the TanStack cache without a manual refresh.
  useMessagesRealtime(leadId, kind);
  const activeProjectId = useProjectId();
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // MEDIA (2026-09-17): attachment picked in the composer (not yet sent).
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Mention picker state (Internal composer only).
  // `mentionQuery` is the substring after the last `@` in the draft; when
  // non-null the picker is active and shows team members matching it.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  // T-USER-PROJECT-SCOPE: pass the ACTIVE project so an ADMIN/OWNER - who has no
  // natural team - is offered that project's staff instead of the whole
  // directory. Staff roles are unaffected (their scope is already their team).
  const teamQuery = useTeamMembers(activeProjectId ?? undefined);

  // Extract the active mention query from the draft: the text after the
  // last `@` (case-insensitive). Returns null when there's no active `@`
  // (e.g. `@` was replaced with a space, or a mention was already inserted).
  function currentMentionQuery(value: string): string | null {
    const at = value.lastIndexOf('@');
    if (at === -1) return null;
    const after = value.slice(at + 1);
    // A trailing space (or no text) closes the suggestion unless it's the
    // bare `@` just typed (empty query → show all).
    if (after.includes(' ')) return null;
    return after;
  }

  const rows = useMemo(() => {
    const data = messagesQuery.data;
    return Array.isArray(data) ? (data as MessageRow[]) : [];
  }, [messagesQuery.data]);

  const grouped = useMemo(() => withDateSeparators(rows), [rows]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (leadId === null) return;
    // MEDIA: allow sending with ONLY an attachment (no text body) too, so a
    // staff can forward an image/doc without typing a caption. Backend
    // requires body non-empty for the Message row, so send a neutral body
    // when there's no typed text.
    const resolvedBody = body.length === 0 && pendingAttachment !== null ? '📎 Attachment' : body;
    if (resolvedBody.length === 0) return;

    const send = (media?: { mediaKey: string; mediaMimeType: string; mediaFilename: string }) => {
      sendMessage.mutate(
        { body: resolvedBody, ...(media !== undefined ? { media } : {}) },
        {
          onSuccess: () => {
            setDraft('');
            setPendingAttachment(null);
            setMentionQuery(null);
            // Reset the auto-grow textarea back to a single line.
            const el = textareaRef.current;
            if (el !== null) el.style.height = 'auto';
            requestAnimationFrame(() => {
              textareaRef.current?.focus();
            });
          },
          onError: (err) => {
            toast.error(err instanceof Error ? err.message : 'Send failed');
          },
        },
      );
    };

    // MEDIA: if there's an attachment, upload it first (base64 → POST
    // /api/media → storage key), then send the message with that key.
    if (pendingAttachment !== null) {
      setAttachmentUploading(true);
      uploadChatMedia(pendingAttachment.file)
        .then((media) => send(media))
        .catch((err) => {
          // Provide user-friendly error messages based on the error type
          let message = 'Upload failed. Please try again.';
          if (err instanceof Error) {
            const apiError = err as { status?: number; code?: string; details?: unknown };
            // Handle specific backend error codes
            if (apiError.status === 413 || apiError.code === 'PAYLOAD_TOO_LARGE') {
              message = `File is too large. Maximum size is ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`;
            } else if (apiError.status === 400) {
              // Backend validation errors (unsupported type, empty file, etc.)
              message = apiError.details
                ? String(apiError.details)
                : err.message.replace(/^API \d+:\s*/, '');
            } else if (apiError.status === 415 || apiError.code === 'UNSUPPORTED_MEDIA_TYPE') {
              message = 'Unsupported file type. Allowed: images, PDFs, text files, videos, and audio.';
            } else {
              message = err.message.replace(/^API \d+:\s*/, '');
            }
          }
          toast.error(message);
        })
        .finally(() => setAttachmentUploading(false));
      return;
    }

    send();
  }

  // MEDIA: pick a file and store a local preview so the composer shows what
  // will be sent before the upload happens.
  function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;

    // Client-side validation before accepting the file
    const validation = validateChatFile(file);
    if (!validation.ok) {
      toast.error(validation.error);
      return;
    }

    setPendingAttachment({
      file,
      previewUrl: URL.createObjectURL(file),
    });
  }

  function removeAttachment() {
    setPendingAttachment((prev) => {
      if (prev !== null) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
  }

  const canSend = leadId !== null && user !== null && !sendMessage.isPending && !attachmentUploading;

  // Enter sends; Shift+Enter inserts a newline.
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend && draft.trim().length > 0) {
        event.currentTarget.form?.requestSubmit();
      }
    }
  }

  // Auto-grow the textarea up to ~5 lines.
  function onInput(event: React.FormEvent<HTMLTextAreaElement>) {
    const el = event.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 5 * 20 + 16)}px`;
  }

  // Insert a @Name mention at the cursor (Internal composer only).
  // Replaces the active `@query` token up to the cursor (e.g. `@De` →
  // `@Demo Manager `) so the query text isn't duplicated.
  function insertMention(name: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const before = draft.slice(0, start);
    // Find the last `@` in the text before the cursor and drop the query
    // portion (the @ and everything up to the cursor), if any.
    const at = before.lastIndexOf('@');
    const head = at === -1 ? before : before.slice(0, at);
    const next = `${head}@${name} ${draft.slice(end)}`;
    setDraft(next);
    setMentionQuery(null);
    // Restore focus + cursor after the mention.
    requestAnimationFrame(() => {
      el?.focus();
      const pos = head.length + name.length + 2;
      el?.setSelectionRange(pos, pos);
    });
  }

  const displayName = leadName ?? 'Lead';
  const isInternal = kind === 'INTERNAL';
  const teamMembers = Array.isArray(teamQuery.data) ? teamQuery.data : [];
  // Filter team members by the active mention query. Empty query shows all.
  const filteredTeamMembers = useMemo(() => {
    if (mentionQuery === null || mentionQuery.length === 0) return teamMembers;
    const q = mentionQuery.toLowerCase();
    return teamMembers.filter(
      (m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
    );
  }, [teamMembers, mentionQuery]);

  return (
    <CardRoot
      className="flex h-full min-h-80 flex-col overflow-hidden border border-border pt-0 gap-0"
      data-qa="lead-chat-card"
    >
      {/* Conversation header - who you're talking to + thread toggle */}
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        <AvatarRoot className="h-8 w-8 shrink-0 rounded-full">
          <AvatarFallback className="rounded-full text-xs">{initials(displayName)}</AvatarFallback>
        </AvatarRoot>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{displayName}</div>
          <div className="text-muted-foreground text-xs">
            {isInternal
              ? 'Internal notes - staff only'
              : rows.length > 0
                ? `${rows.length} message${rows.length === 1 ? '' : 's'}`
                : 'No messages yet'}
          </div>
        </div>
        <ToggleGroup
          type="single"
          value={kind}
          onValueChange={(v) => {
            const next = Array.isArray(v) ? v[0] : v;
            if (next === 'CUSTOMER' || next === 'INTERNAL') setKind(next);
          }}
          items={[
            { value: 'CUSTOMER', content: 'Customer' },
            { value: 'INTERNAL', content: 'Internal' },
          ]}
          aria-label="Chat thread"
        />
      </div>

      <CardContent className="min-h-0 flex-1 p-0">
        <div className="h-full overflow-hidden bg-muted/20" data-qa="chat-messages">
          {messagesQuery.isLoading ? (
            <p className="text-muted-foreground p-4 text-xs text-center">Loading messages...</p>
          ) : messagesQuery.error !== null && messagesQuery.error !== undefined ? (
            <p className="text-muted-foreground p-4 text-xs text-center">
              Chat will appear when the chat module lands. (Backend not yet
              wired for this lead.)
            </p>
          ) : rows.length === 0 ? (
            // Empty state - rendered OUTSIDE the MessageScroller so there's
            // no scroll container when there are no messages.
            <div className="flex h-full items-center justify-center">
              <Empty
                className="p-6"
                media={isInternal ? <LuLock className="size-full" /> : <LuMessageSquare className="size-full" />}
                mediaVariant="icon"
                title={isInternal ? 'No internal notes yet' : 'No messages yet'}
                description={
                  isInternal
                    ? 'Loop your team with @mentions.'
                    : 'Send the first message below.'
                }
              />
            </div>
          ) : (
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <MessageScroller className="flex-1">
              <MessageScrollerViewport>
                <MessageScrollerContent className="min-h-full justify-end gap-3 p-4 py-4 **:data-message-scroller-spacer:hidden">
                  {grouped.map((entry) => {
                      if (entry.type === 'separator') {
                        return (
                          <MessageScrollerItem key={`sep-${entry.label}`}>
                            <Marker variant="separator">
                              <MarkerContent>
                                <span className="text-muted-foreground text-xs">{entry.label}</span>
                              </MarkerContent>
                            </Marker>
                          </MessageScrollerItem>
                        );
                      }
                      const message = entry.row;
                      const id =
                        typeof message.id === 'string' ? message.id : `m-${entry.index}`;
                      const direction: Direction = isMessageDirection(
                        message.direction,
                      )
                        ? message.direction
                        : 'IN';
                      const isOut = direction === 'OUT';
                      return (
                        <ChatMessage
                          key={id}
                          id={id}
                          isOut={isOut}
                          isInternal={message.kind === 'INTERNAL'}
                          senderName={
                            message.senderName ??
                            (isOut ? 'You' : 'Customer')
                          }
                          body={message.body ?? ''}
                          createdAt={message.createdAt}
                          channel={message.channel}
                          // MEDIA (2026-09-17): render images inline / docs as link.
                          mediaUrl={message.mediaUrl}
                          mediaType={message.mediaType ?? null}
                          mediaFilename={message.mediaFilename ?? null}
                        />
                      );
                    })
                  }
                </MessageScrollerContent>
                <MessageScrollerButton direction="end" />
              </MessageScrollerViewport>
            </MessageScroller>
          </MessageScrollerProvider>
        )}
        </div>
      </CardContent>

      <CardFooter className="flex flex-col gap-2 border-t p-2">
        <form
          onSubmit={onSubmit}
          className="w-full"
          data-qa="chat-send-form"
        >
          {/* MEDIA (2026-09-17): hidden file input driving the paperclip button. */}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept="image/*,application/pdf,text/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
            onChange={onPickFile}
            aria-hidden="true"
            data-qa="chat-file-input"
          />
          {/* MEDIA: show the picked attachment with a preview + remove action
              before it's uploaded on send. */}
          {pendingAttachment !== null ? (
            <div className="mb-2" data-qa="chat-attachment-preview">
              <Attachment
                state={attachmentUploading ? 'uploading' : 'idle'}
                orientation="horizontal"
                className="border-border rounded-md border bg-muted/30 p-2 w-auto"
              >
                {pendingAttachment.file.type.startsWith('image/') ? (
                  <img
                    src={pendingAttachment.previewUrl}
                    alt={pendingAttachment.file.name}
                    className="h-14 w-14 shrink-0 rounded object-cover"
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <AttachmentTitle className="text-sm font-medium">
                    {pendingAttachment.file.name}
                  </AttachmentTitle>
                  <AttachmentDescription className="text-muted-foreground text-xs">
                    {formatBytes(pendingAttachment.file.size)}
                  </AttachmentDescription>
                </div>
                <AttachmentActions>
                  <InputGroupButton
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={removeAttachment}
                    disabled={attachmentUploading}
                    aria-label="Remove attachment"
                    data-qa="chat-attachment-remove"
                  >
                    <LuX className="size-4" />
                  </InputGroupButton>
                </AttachmentActions>
              </Attachment>
            </div>
          ) : null}
          <InputGroup className="gap-1 items-center h-10">
            <div className="relative min-w-0 flex-1">
              <InputGroupTextarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                  // Open the mention picker when the user types `@` in the
                  // Internal composer. `currentMentionQuery` returns the
                  // text after the last `@` ('' for bare `@`) or null when
                  // there's no active mention. Closing on a space lets the
                  // picker filter as they keep typing.
                  if (isInternal) {
                    const q = currentMentionQuery(event.currentTarget.value);
                    setMentionQuery(q === null ? null : q.toLowerCase());
                  }
                }}
                onInput={onInput}
                onKeyDown={onKeyDown}
                rows={1}
                placeholder={
                  leadId !== null && user !== null
                    ? isInternal
                      ? 'Internal note... @ to mention a teammate'
                      : 'Type a message... (Enter to send)'
                    : 'Sign in to send a message'
                }
                disabled={!canSend}
                className="max-h-0 min-h-10 w-full resize-none py-2.5 text-sm wrap-anywhere [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
                aria-label="Message body"
                data-qa="chat-input"
              />
              {isInternal && mentionQuery !== null && filteredTeamMembers.length > 0 ? (
                <div className="absolute bottom-full left-0 right-0 z-50 mb-2 rounded-lg border border-border bg-popover shadow-lg">
                  <div className="max-h-56 overflow-y-auto p-1">
                    <div className="text-muted-foreground px-2 py-1 text-xs font-semibold uppercase">
                      Mention a teammate{mentionQuery && mentionQuery.length > 0 ? ` (${mentionQuery})` : ''}
                    </div>
                    {filteredTeamMembers.map((member) => (
                      <button
                        key={member.id}
                        type="button"
                        onClick={() => insertMention(member.name)}
                        className="hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
                        data-qa="mention-option"
                      >
                        <AvatarRoot className="h-6 w-6 shrink-0 rounded-full">
                          <AvatarFallback className="rounded-full text-[10px]">
                            {initials(member.name)}
                          </AvatarFallback>
                        </AvatarRoot>
                        <span className="min-w-0 flex-1 truncate">{member.name}</span>
                        <span className="text-muted-foreground text-[10px] uppercase">
                          {member.role}
                        </span>
                      </button>
                    ))}
                    {filteredTeamMembers.length === 0 ? (
                      <div className="text-muted-foreground px-2 py-3 text-center text-xs">
                        No matches
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
            <InputGroupAddon align="inline-end" className="p-2">
              {/* MEDIA (2026-09-17): paperclip opens the file picker for both
                  CUSTOMER and INTERNAL threads. */} 
              <InputGroupButton
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={!canSend}
                aria-label="Attach a file"
                data-qa="chat-attach-button"
              >
                <LuPaperclip className="size-4" />
              </InputGroupButton>
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-sm"
                disabled={!canSend || (draft.trim().length === 0 && pendingAttachment === null) || sendMessage.isPending || attachmentUploading}
                data-qa="chat-send-button"
                aria-label="Send message"
              >
                {sendMessage.isPending || attachmentUploading ? (
                  <LuRefreshCw className="size-4 animate-spin" />
                ) : (
                  <LuArrowUp />
                )}
                <span className="sr-only">Send</span>
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </CardFooter>
    </CardRoot>
  );
}

/**
 * A single chat row. OUT (staff → customer) aligns to the end (right)
 * with a muted bubble; IN (customer → staff) aligns to the start (left)
 * with a tinted bubble. The sender name + avatar show for incoming
 * messages; the current user's own messages show the name on the right.
 * Internal notes render with a distinct badge + tint so staff can tell
 * them apart from the customer thread at a glance.
 */
function ChatMessage({
  id,
  isOut,
  isInternal,
  senderName,
  body,
  createdAt,
  channel,
  mediaUrl,
  mediaType,
  mediaFilename,
}: {
  id: string;
  isOut: boolean;
  isInternal: boolean;
  senderName: string;
  body: string;
  createdAt?: string;
  channel?: Channel;
  // MEDIA (2026-09-17): attachment for type-aware rendering.
  mediaUrl?: string | null;
  mediaType?: string | null;
  mediaFilename?: string | null;
}) {
  const mediaIsImage = mediaType !== null && mediaType !== undefined && mediaType.startsWith('image/');
  const mediaIsPdf = mediaType === 'application/pdf';
  // MEDIA: a stored key can outlive its bytes (e.g. MEDIA_STORAGE switched
  // between local disk and imagekit - see the chat-media-storage skill note).
  // Track the failure in state and render a link-shaped fallback instead of a
  // broken-image icon, so the attachment stays clickable and diagnosable.
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <MessageScrollerItem messageId={id} scrollAnchor={isOut}>
      <Message align={isOut ? 'end' : 'start'}>
        <MessageAvatar>
          <AvatarRoot className="h-8 w-8 shrink-0 rounded-full">
            <AvatarFallback className="rounded-full text-xs">
              {initials(senderName)}
            </AvatarFallback>
          </AvatarRoot>
        </MessageAvatar>
        <MessageContent>
          <MessageHeader
            className={
              isOut
                ? 'justify-end text-muted-foreground'
                : 'justify-start text-muted-foreground'
            }
          >
            <span className="text-xs font-medium">{senderName}</span>
            {isInternal ? (
              <span className="bg-muted text-muted-foreground ml-1 rounded px-1 py-0.5 text-[9px] font-semibold uppercase">
                Internal
              </span>
            ) : null}
          </MessageHeader>
          <Bubble
            align={isOut ? 'end' : 'start'}
            variant={isInternal ? 'muted' : isOut ? 'muted' : 'tinted'}
          >
            <BubbleContent>
              {/* MEDIA (2026-09-17): render images inline; other files as a
                  download link (documents, video, audio). */}
              {mediaUrl !== null && mediaUrl !== undefined && mediaUrl.length > 0 ? (
                <div className="mb-1.5">
                  {mediaIsImage && !imageFailed ? (
                    <a href={mediaUrl} target="_blank" rel="noopener noreferrer">
                      {/* Bytes load through the BFF (needs the session
                          cookie), so a plain <img> is correct here. */}
                      <AttachmentImage
                        src={mediaUrl}
                        alt={mediaFilename ?? 'attachment'}
                        className="max-h-56 w-auto max-w-full rounded-lg border border-border"
                        onFailed={() => setImageFailed(true)}
                      />
                    </a>
                  ) : mediaIsImage && imageFailed ? (
                    // Bytes are gone (dead key / storage backend switched).
                    // Keep it a link so the file is still reachable if it
                    // comes back, and label it honestly instead of showing
                    // the browser's broken-image glyph.
                    <a
                      href={mediaUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
                      data-qa="chat-media-image-failed"
                    >
                      <LuFile className="size-4 shrink-0" />
                      <span className="min-w-0 truncate">
                        {mediaFilename ?? 'Image'} (preview unavailable)
                      </span>
                    </a>
                  ) : mediaIsPdf ? (
                    <a
                      href={mediaUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
                      data-qa="chat-media-doc"
                    >
                      <LuFile className="size-4 shrink-0" />
                      <span className="min-w-0 truncate">{mediaFilename ?? 'Document'}</span>
                    </a>
                  ) : (
                    <a
                      href={mediaUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
                      data-qa="chat-media-file"
                    >
                      <LuFile className="size-4 shrink-0" />
                      <span className="min-w-0 truncate">{mediaFilename ?? 'Attachment'}</span>
                    </a>
                  )}
                </div>
              ) : null}
              <p
                className="wrap-break-word text-sm"
                data-qa="chat-message"
                data-direction={isOut ? 'out' : 'in'}
                data-kind={isInternal ? 'internal' : 'customer'}
              >
                {body}
              </p>
            </BubbleContent>
          </Bubble>
          <MessageFooter
            className={
              isOut
                ? 'justify-end text-muted-foreground'
                : 'justify-start text-muted-foreground'
            }
          >
            <span className="text-[10px]">
              {formatMessageTime(createdAt)}
              {channel === 'WHATSAPP' && !isInternal ? ' · WhatsApp' : ''}
            </span>
          </MessageFooter>
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  );
}
