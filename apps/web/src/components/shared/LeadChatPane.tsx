'use client';

// LeadChatPane - embedded chat panel on the lead detail page.
//
// Wired to the chat backend (T-CHAT, Pass 1):
//   - useMessages(leadId): GET /api/chat/:leadId → bare array
//     ordered oldest → newest.
//   - useSendMessage(leadId): POST /api/chat/send → on success,
//     invalidates the messages query (refetch replaces the optimistic
//     row with the server-returned MessageEvent including the real id
//     and timestamp).
//
// Per-message styling: OUT messages (staff → customer) right-aligned,
// blue background; IN messages (customer → staff) left-aligned, muted
// background. This mirrors WhatsApp / iMessage conventions so a new
// user reads the conversation immediately.
//
// Auto-scroll: the pane scrolls to the bottom on every new message
// via a useEffect that depends on the message count + the last
// message id (so an SSE-driven refetch also scrolls). We don't
// sticky-position the bottom bar; instead the scrollable list owns
// the scroll so the input bar stays at the bottom.
//
// Live updates (SSE) are deferred to Week 7 per the chat plan. For
// now, sending a message invalidates the query → refetch → render.
// Good enough for the demo loop.

import { Button, toast } from '@paalstack/react-ui';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useMessages, useMessagesRealtime, useSendMessage } from '@/hooks/queries/crm';
import { useSessionUser } from '@/lib/session';

type Direction = 'IN' | 'OUT';
type Channel = 'WHATSAPP' | 'IN_APP';

type MessageRow = {
  id: string;
  leadId?: string;
  direction?: Direction;
  channel?: Channel;
  body?: string;
  mediaUrl?: string | null;
  createdAt?: string;
};

function isMessageDirection(value: unknown): value is Direction {
  return value === 'IN' || value === 'OUT';
}

function formatMessageTime(value: string | undefined): string {
  if (value === undefined) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
  });
}

export function LeadChatPane({ leadId }: { leadId: string | null }) {
  const { user } = useSessionUser();
  const messagesQuery = useMessages(leadId);
  const sendMessage = useSendMessage(leadId ?? '');
  // T-E2 (Week 6): live message stream - invalidates the chat query
  // whenever a new Message row lands (inbound WhatsApp, another staff
  // member's reply, or the customer's own message). The pane re-renders
  // from the TanStack cache without a manual refresh.
  useMessagesRealtime(leadId);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => {
    const data = messagesQuery.data;
    return Array.isArray(data) ? (data as MessageRow[]) : [];
  }, [messagesQuery.data]);

  const lastId =
    rows.length > 0
      ? typeof rows[rows.length - 1]?.id === 'string'
        ? (rows[rows.length - 1] as { id: string }).id
        : `${rows.length}`
      : null;

  // Auto-scroll to bottom on every new message (or first load).
  // We intentionally don't depend on draft state - typing shouldn't
  // pull the user's view down; only when the conversation grows.
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [lastId, rows.length]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (body.length === 0) return;
    if (leadId === null) return;
    sendMessage.mutate(body, {
      onSuccess: () => {
        setDraft('');
      },
      onError: (err) => {
        // Server validation messages come through verbatim on 400
        // (parseBody in chat.controller.ts turns ZodError → 400).
        // Surface them via the global sonner toast singleton.
        //
        // Imported statically - NOT via lazy require(): a CJS require()
        // resolves this dual-format package's `dist/index.cjs`, whose
        // sonner `toast` singleton is a SEPARATE module instance from
        // the ESM build that `<Toaster/>` (app root) listens to. Toasts
        // fired from the CJS copy never render. The component is
        // already a client component importing `Button` from the same
        // package, so a static import costs nothing.
        toast.error(err instanceof Error ? err.message : 'Send failed');
      },
    });
  }

  const canSend = leadId !== null && user !== null && !sendMessage.isPending;

  return (
    <div className="flex h-full min-h-[20rem] flex-col">
      <div
        ref={scrollRef}
        className="flex-1 space-y-2 overflow-y-auto p-4"
        data-qa="chat-messages"
      >
        {messagesQuery.isLoading ? (
          <p className="text-muted-foreground text-xs">Loading messages…</p>
        ) : messagesQuery.error !== null &&
          messagesQuery.error !== undefined ? (
          <p className="text-muted-foreground text-xs">
            Chat will appear when the chat module lands. (Backend not yet
            wired for this lead.)
          </p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No messages yet. Send the first message below.
          </p>
        ) : (
          rows.map((message, index) => {
            const id =
              typeof message.id === 'string' ? message.id : `m-${index}`;
            const direction: Direction = isMessageDirection(message.direction)
              ? message.direction
              : 'IN';
            const isOut = direction === 'OUT';
            return (
              <div
                key={id}
                className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}
                data-qa="chat-message"
                data-direction={direction.toLowerCase()}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                    isOut
                      ? 'bg-blue-600 text-white'
                      : 'bg-muted text-foreground'
                  }`}
                >
                  <p className="break-words">{message.body ?? ''}</p>
                  <p
                    className={`mt-1 text-[10px] ${
                      isOut ? 'text-blue-100' : 'text-muted-foreground'
                    }`}
                  >
                    {formatMessageTime(message.createdAt)}
                    {message.channel === 'WHATSAPP' ? ' · WhatsApp' : ''}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>

      <form
        onSubmit={onSubmit}
        className="border-border flex gap-2 border-t p-3"
        data-qa="chat-send-form"
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder={
            leadId !== null && user !== null
              ? 'Type a message…'
              : 'Sign in to send a message'
          }
          disabled={!canSend}
          className="border-input bg-background focus-visible:ring-ring min-h-11 flex-1 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
          aria-label="Message body"
          data-qa="chat-input"
        />
        <Button
          type="submit"
          size="sm"
          className="min-h-11"
          disabled={!canSend || draft.trim().length === 0}
          data-qa="chat-send-button"
        >
          {sendMessage.isPending ? 'Sending…' : 'Send'}
        </Button>
      </form>
    </div>
  );
}