'use client';

// ChatThreadPanel - the RIGHT pane of the WhatsApp chat system.
//
// One component serves BOTH thread types so the window looks and behaves
// identically whether you are talking to a known customer (a Lead) or to a
// number that is not a lead yet (a WhatsappUnknownContact):
//
//   kind = 'LEAD'    -> useMessages(leadId)      + POST /api/chat/send
//   kind = 'CONTACT' -> useContactMessages(id)   + POST /api/chat/send-to-contact
//
// The message bubbles are NOT reimplemented here - `ChatMessage` is imported
// from LeadChatPane so a bubble renders the same way everywhere (avatar,
// direction alignment, media, timestamps). That is deliberate: two bubble
// implementations would drift.
//
// WhatsApp Web affordances provided here:
//   - conversation header (name, phone, who it is)
//   - the 24h reply-window indicator, which BLOCKS the send outside the window
//     instead of letting it fail silently in the outbound cron (Meta only
//     accepts a freeform reply within 24h of the customer's last message)
//   - a "Convert to lead" action on unknown-contact threads
//   - composer with Enter-to-send, Shift+Enter for a newline, attachments

import {
  AvatarFallback,
  AvatarRoot,
  Button,
  Empty,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  Marker,
  MarkerContent,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  toast,
} from '@paalstack/react-ui';
import {
  LuArrowUp,
  LuCircleAlert,
  LuMessageSquare,
  LuPaperclip,
  LuUserPlus,
  LuX,
} from '@paalstack/react-icons/lu';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  uploadChatMedia,
  useContactMessages,
  useContactMessagesRealtime,
  useMarkChatRead,
  useMessages,
  useMessagesRealtime,
  useSendContactMessage,
  useSendMessage,
} from '@/hooks/queries/crm';
import { dateIntl } from '@/lib/format';

import {
  ChatMessage,
  separatorLabel,
  validateChatFile,
  withDateSeparators,
} from '@/components/shared/LeadChatPane';

// Derived from the helper's own return type, so a change to the separator
// shape surfaces here as a type error rather than a runtime surprise.
type GroupedEntry = ReturnType<typeof withDateSeparators>[number];

type Direction = 'IN' | 'OUT';
type Channel = 'WHATSAPP' | 'IN_APP';

export type ChatThreadSelection = {
  kind: 'LEAD' | 'CONTACT';
  id: string;
  displayName: string;
  phoneE164: string;
  /** Set for a CONTACT thread whose number is already linked to a lead. */
  linkedLeadId: string | null;
  /** ISO timestamp of the customer's last inbound, for the 24h window. */
  lastInboundAt: string | null;
  /** Where to open the full lead page (LEAD threads). */
  leadHref?: string;
};

type WireMessage = {
  id: string;
  direction?: Direction;
  channel?: Channel;
  kind?: 'CUSTOMER' | 'INTERNAL';
  body?: string;
  mediaUrl?: string | null;
  mediaType?: string | null;
  mediaFilename?: string | null;
  senderName?: string | null;
  createdAt?: string;
};

// ────────────────────────────────────────────────────────────────────────────
// The 24h WhatsApp reply window
// ────────────────────────────────────────────────────────────────────────────

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Meta only accepts a FREEFORM (plain text) reply within 24h of the customer's
 * last inbound message. Outside it, the send is rejected - and because the
 * reply is queued through the outbound cron, that failure used to be invisible
 * in the UI. Returning the state lets the composer block it and say why.
 *
 * `lastInboundAt === null` (customer has never written) also counts as closed:
 * there is no open service window to reply into.
 */
export function replyWindowState(
  lastInboundAt: string | null,
  now: Date = new Date(),
): { open: boolean; expiresAt: Date | null } {
  if (lastInboundAt === null) return { open: false, expiresAt: null };
  const last = new Date(lastInboundAt);
  if (Number.isNaN(last.getTime())) return { open: false, expiresAt: null };
  const expiresAt = new Date(last.getTime() + WINDOW_MS);
  return { open: now.getTime() < expiresAt.getTime(), expiresAt };
}

/** Human copy for the closed window, used in the composer + tooltip. */
export function closedWindowMessage(): string {
  return (
    'The 24-hour WhatsApp reply window has closed. Meta only delivers a ' +
    'freeform reply within 24h of the customer\u2019s last message, so this ' +
    'message cannot be sent until they write again.'
  );
}

// ────────────────────────────────────────────────────────────────────────────

export function ChatThreadPanel({
  thread,
  onConvert,
}: {
  thread: ChatThreadSelection;
  /** Present only for CONTACT threads; opens the convert-to-lead flow. */
  onConvert?: (thread: ChatThreadSelection) => void;
}) {
  const isContact = thread.kind === 'CONTACT';

  // Two data paths, one UI. Hooks cannot be called conditionally, so both are
  // always invoked and each is disabled by a null id (standard pattern in this
  // repo - see useMessages).
  const leadMessages = useMessages(isContact ? null : thread.id);
  const contactMessages = useContactMessages(isContact ? thread.id : null);
  useMessagesRealtime(isContact ? null : thread.id);
  useContactMessagesRealtime(isContact ? thread.id : null);

  const sendLead = useSendMessage(isContact ? '' : thread.id);
  const sendContact = useSendContactMessage(isContact ? thread.id : '');
  const markRead = useMarkChatRead();

  const query = isContact ? contactMessages : leadMessages;
  const send = isContact ? sendContact : sendLead;

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<{
    file: File;
    previewUrl: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset the composer when the selection changes, so a draft written for one
  // customer can never be sent to another by accident.
  useEffect(() => {
    setDraft('');
    setPending(null);
  }, [thread.kind, thread.id]);

  // Opening a thread clears THIS user's unread badge. Keyed on the thread so
  // switching conversations marks each one as it is read.
  // Marks the thread read when it is opened. Deliberately keyed on the thread
  // identity only: including the mutation object would re-fire this write on
  // every render (it is a new object each time), turning a single read-mark
  // into a request per keystroke.
  const markReadRef = useRef(markRead);
  markReadRef.current = markRead;
  useEffect(() => {
    const payload = isContact ? { contactId: thread.id } : { leadId: thread.id };
    markReadRef.current.mutate(payload);
  }, [isContact, thread.id]);

  const rows = useMemo<WireMessage[]>(() => {
    const data = query.data;
    return Array.isArray(data) ? (data as WireMessage[]) : [];
  }, [query.data]);

  const grouped = useMemo(() => withDateSeparators(rows, new Date()), [rows]);

  const windowState = replyWindowState(thread.lastInboundAt);
  const sendDisabled = !windowState.open || draft.trim().length === 0 || send.isPending;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendDisabled) return;
    const body = draft.trim();
    if (body.length === 0) return;
    try {
      let media:
        | { mediaKey: string; mediaMimeType: string; mediaFilename: string }
        | undefined;
      if (pending !== null) {
        setUploading(true);
        media = await uploadChatMedia(pending.file);
        setUploading(false);
      }
      await send.mutateAsync({ body, ...(media !== undefined ? { media } : {}) });
      setDraft('');
      setPending(null);
      if (textareaRef.current !== null) textareaRef.current.style.height = 'auto';
    } catch (error) {
      setUploading(false);
      toast.error(
        error instanceof Error ? error.message : 'Could not send the message.',
      );
    }
  }

  function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    const validation = validateChatFile(file);
    if (!validation.ok) {
      toast.error(validation.error);
      return;
    }
    setPending({ file, previewUrl: URL.createObjectURL(file) });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter inserts a newline (WhatsApp Web behaviour).
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <div
      className="bg-card flex h-full min-h-0 flex-col overflow-hidden"
      data-qa="chat-thread-panel"
      data-thread-kind={thread.kind}
      data-thread-id={thread.id}
    >
      {/* ── Conversation header ─────────────────────────────────────────── */}
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        <AvatarRoot className="h-9 w-9 shrink-0 rounded-full">
          <AvatarFallback className="rounded-full text-xs">
            {initialsOf(thread.displayName)}
          </AvatarFallback>
        </AvatarRoot>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold" data-qa="thread-name">
              {thread.displayName}
            </span>
            {isContact ? (
              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">
                Not a lead yet
              </span>
            ) : null}
          </div>
          <div className="text-muted-foreground truncate text-xs" data-qa="thread-phone">
            {thread.phoneE164}
            {/* A contact whose number already matches a lead: say so, so staff
                know the conversation is not orphaned. */}
            {isContact && thread.linkedLeadId !== null ? ' · linked to a lead' : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {thread.leadHref !== undefined ? (
            <Button variant="ghost" size="sm" asChild>
              <Link href={thread.leadHref}>Open lead</Link>
            </Button>
          ) : null}
          {isContact && onConvert !== undefined ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onConvert(thread)}
              data-qa="convert-to-lead"
            >
              <LuUserPlus className="size-4" />
              Convert to lead
            </Button>
          ) : null}
        </div>
      </div>

      {/* ── Messages ────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-hidden bg-muted/20" data-qa="chat-messages">
        {query.isLoading ? (
          <p className="text-muted-foreground p-4 text-center text-xs">
            Loading messages...
          </p>
        ) : query.error !== null && query.error !== undefined ? (
          <p className="text-muted-foreground p-4 text-center text-xs">
            Could not load this conversation. Try selecting it again.
          </p>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Empty
              className="p-6"
              media={<LuMessageSquare className="size-full" />}
              mediaVariant="icon"
              title="No messages yet"
              description="Send the first message below."
            />
          </div>
        ) : (
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <MessageScroller className="flex-1">
              <MessageScrollerViewport>
                <MessageScrollerContent className="min-h-full justify-end gap-3 p-4 py-4 **:data-message-scroller-spacer:hidden">
                  {grouped.map((entry: GroupedEntry) => {
                    if (entry.type === 'separator') {
                      return (
                        <Marker key={`sep-${entry.label}`} variant="separator">
                          <MarkerContent>{entry.label}</MarkerContent>
                        </Marker>
                      );
                    }
                    const m = entry.row as WireMessage;
                    const isOut = m.direction === 'OUT';
                    return (
                      <ChatMessage
                        key={m.id}
                        id={m.id}
                        isOut={isOut}
                        isInternal={m.kind === 'INTERNAL'}
                        senderName={m.senderName ?? (isOut ? 'You' : thread.displayName)}
                        body={m.body ?? ''}
                        createdAt={m.createdAt}
                        channel={m.channel}
                        mediaUrl={m.mediaUrl}
                        mediaType={m.mediaType ?? null}
                        mediaFilename={m.mediaFilename ?? null}
                      />
                    );
                  })}
                </MessageScrollerContent>
                <MessageScrollerButton direction="end" />
              </MessageScrollerViewport>
            </MessageScroller>
          </MessageScrollerProvider>
        )}
      </div>

      {/* ── Composer ────────────────────────────────────────────────────── */}
      <div className="border-border border-t p-3">
        {pending !== null ? (
          <div className="bg-muted mb-2 flex items-center gap-2 rounded p-2 text-xs">
            <LuPaperclip className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{pending.file.name}</span>
            <button
              type="button"
              className="hover:bg-background rounded p-1"
              onClick={() => setPending(null)}
              aria-label="Remove attachment"
            >
              <LuX className="size-3.5" />
            </button>
          </div>
        ) : null}

        {/* The window warning replaces the composer entirely when closed:
            an input the user cannot submit is worse than a clear explanation. */}
        {!windowState.open ? (
          <div
            className="text-muted-foreground flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs"
            data-qa="reply-window-closed"
          >
            <LuCircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span>{closedWindowMessage()}</span>
          </div>
        ) : (
          <form onSubmit={onSubmit}>
            <InputGroup className="items-center gap-1">
              <InputGroupTextarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={`Message ${thread.displayName}`}
                rows={1}
                aria-label="Message"
                data-qa="composer"
              />
              <InputGroupAddon align="inline-end" className="p-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={onPickFile}
                  data-qa="composer-file"
                />
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach a file"
                >
                  <LuPaperclip className="size-4" />
                </InputGroupButton>
                <InputGroupButton
                  type="submit"
                  size="icon-sm"
                  disabled={sendDisabled}
                  aria-label="Send"
                  data-qa="composer-send"
                >
                  <LuArrowUp />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {pending !== null ? null : (
              <p className="text-muted-foreground mt-1 text-[10px]">
                {uploading ? 'Uploading attachment...' : 'Enter to send, Shift+Enter for a new line'}
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

export { separatorLabel, dateIntl };
