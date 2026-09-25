'use client';

// ChatConversationList - the LEFT pane of the WhatsApp chat system.
//
// WhatsApp Web's list column: one row per conversation with the contact name,
// a one-line preview of the last message, the time, and an unread badge.
// Selecting a row drives the right pane.
//
// Data comes from GET /api/chat/conversations, which is SERVER-filtered
// (search / kind / unread-only / paging) - the list never sifts a loaded page
// client-side. Both thread types appear here: known leads (by name) and
// not-yet-converted numbers (by number).

import {
  Badge,
  Empty,
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  Skeleton,
  ToggleGroup,
} from '@paalstack/react-ui';
import {
  LuMessagesSquare,
  LuSearch,
} from '@paalstack/react-icons/lu';
import { useDebouncedValue } from '@paalstack/react-hooks';
import { useMemo, useState } from 'react';

import { useChatConversations } from '@/hooks/queries/crm';
import { dateIntl } from '@/lib/format';

import type { ChatThreadSelection } from './ChatThreadPanel';

type FilterMode = 'ALL' | 'UNREAD' | 'LEAD' | 'CONTACT';

const FILTERS: ReadonlyArray<{ value: FilterMode; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'UNREAD', label: 'Unread' },
  { value: 'LEAD', label: 'Leads' },
  { value: 'CONTACT', label: 'Unknown' },
];

/**
 * WhatsApp-style timestamp for a list row.
 *
 * Uses the repo's sanctioned intl helper (`dateIntl.formatRelativeTime`), not
 * a hand-rolled formatter - lib/format.ts mandates the @paalstack/react-ui/lib
 * intl classes for ALL date formatting. The library already returns
 * "today at 14:05" / "last Wednesday at 1:19 AM" style strings, which is the
 * WhatsApp Web reading.
 */
export function conversationTime(iso: string): string {
  const raw = dateIntl.formatRelativeTime(iso);
  if (raw.length === 0) return raw;
  // The library lowercases the day prefix; capitalize so the cell reads as a
  // sentence (same treatment as the leads inbox).
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** One-line preview. Our own last message is prefixed so the direction is
 *  readable at a glance (WhatsApp Web shows a tick; text is clearer here). */
export function conversationPreview(
  body: string,
  direction: 'IN' | 'OUT',
): string {
  const text = body.trim().length > 0 ? body.trim() : 'Attachment';
  return direction === 'OUT' ? `You: ${text}` : text;
}

export function ChatConversationList({
  selectedKey,
  onSelect,
  orgSlug,
}: {
  selectedKey: string | null;
  onSelect: (thread: ChatThreadSelection) => void;
  orgSlug: string;
}) {
  const [filter, setFilter] = useState<FilterMode>('ALL');
  const [search, setSearch] = useState('');
  // Repo convention (leads/bookings/admin-users): server-side search is
  // debounced 300ms and only fires at >=2 chars. Without this the list issued
  // one request per keystroke - typing a 10-digit number made 10 round trips.
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const effectiveSearch = debouncedSearch.trim().length >= 2 ? debouncedSearch.trim() : '';

  const query = useChatConversations({
    ...(effectiveSearch.length > 0 ? { search: effectiveSearch } : {}),
    ...(filter === 'LEAD' || filter === 'CONTACT' ? { kind: filter } : {}),
    ...(filter === 'UNREAD' ? { unreadOnly: true } : {}),
    limit: 50,
  });

  const rows = useMemo(
    () => (Array.isArray(query.data?.rows) ? query.data.rows : []),
    [query.data],
  );

  return (
    <div
      className="bg-card flex h-full min-h-0 w-full flex-col overflow-hidden md:w-80 lg:w-96"
      data-qa="chat-conversation-list"
    >
      {/* Header: title + total unread, then search, then filter chips. */}
      <div className="border-border border-b p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">Chats</span>
          {query.data !== undefined && query.data.totalUnread > 0 ? (
            <Badge variant="secondary" data-qa="total-unread">
              {query.data.totalUnread} unread
            </Badge>
          ) : null}
        </div>

        <InputGroup className="mb-2">
          <InputGroupAddon>
            <LuSearch className="size-4" />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or number"
            aria-label="Search conversations"
            data-qa="conversation-search"
          />
        </InputGroup>

        {/* ToggleGroup, not Combobox: four fixed modes are better as visible
            chips (one click, no portal) and they carry real button semantics,
            so the gating is verifiable. Same pattern as LeadChatPane. */}
        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(v) => {
            const next = Array.isArray(v) ? v[0] : v;
            if (next !== undefined && next.length > 0) setFilter(next as FilterMode);
          }}
          items={FILTERS.map((f) => ({ value: f.value, content: f.label }))}
          aria-label="Filter conversations"
        />
      </div>

      {/* Rows */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Empty
              className="p-6"
              media={<LuMessagesSquare className="size-full" />}
              mediaVariant="icon"
              title="No conversations"
              description={
                effectiveSearch.length > 0
                  ? 'No chat matches that search.'
                  : 'WhatsApp messages will appear here as they arrive.'
              }
            />
          </div>
        ) : (
          <ul data-qa="conversation-rows">
            {rows.map((row) => {
              const isSelected = selectedKey === row.threadKey;
              return (
                <li key={row.threadKey}>
                  <button
                    type="button"
                    onClick={() => onSelect(toSelection(row, orgSlug))}
                    aria-current={isSelected ? 'true' : undefined}
                    className={`border-border hover:bg-muted/60 flex w-full items-start gap-3 border-b px-3 py-2.5 text-left transition-colors ${
                      isSelected ? 'bg-muted' : ''
                    }`}
                    data-qa="conversation-row"
                    data-thread-key={row.threadKey}
                  >
                    {/* Unread accent, mirroring WhatsApp's left indicator. */}
                    <span
                      aria-hidden="true"
                      className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                        row.unreadCount > 0 ? 'bg-success' : 'bg-transparent'
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {row.displayName}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-[10px]">
                          {conversationTime(row.lastMessageAt)}
                        </span>
                      </span>
                      {/* A contact whose number matches a lead: show the phone
                          as the subtitle so the two identifiers are visible. */}
                      {row.threadKind === 'CONTACT' ? (
                        <span className="text-muted-foreground block truncate text-[10px]">
                          {row.phoneE164}
                          {row.linkedLeadId !== null ? ' · linked to a lead' : ''}
                        </span>
                      ) : null}
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="text-muted-foreground truncate text-xs">
                          {conversationPreview(row.lastMessageBody, row.lastMessageDirection)}
                        </span>
                        {row.unreadCount > 0 ? (
                          <Badge
                            className="shrink-0"
                            data-qa="row-unread-count"
                          >
                            {row.unreadCount}
                          </Badge>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Map an API row to the selection the right pane needs.
 *
 *  For a LEAD thread the full lead page lives at
 *  /{orgSlug}/projects/{projectSlug}/leads/{id} - but the conversations row
 *  does not carry the project slug, so `leadHref` is only set when it is
 *  known. An href that cannot be honoured is worse than no link.
 */
export function toSelection(
  row: {
    threadKind: 'LEAD' | 'CONTACT';
    threadId: string;
    threadKey: string;
    displayName: string;
    phoneE164: string;
    linkedLeadId: string | null;
    lastInboundAt: string | null;
  },
  orgSlug: string,
  projectSlug?: string,
): ChatThreadSelection {
  const leadHref =
    row.threadKind === 'LEAD' && projectSlug !== undefined
      ? `/${orgSlug}/projects/${projectSlug}/leads/${row.threadId}`
      : undefined;
  return {
    kind: row.threadKind,
    id: row.threadId,
    displayName: row.displayName,
    phoneE164: row.phoneE164,
    linkedLeadId: row.linkedLeadId,
    lastInboundAt: row.lastInboundAt,
    ...(leadHref !== undefined ? { leadHref } : {}),
  };
}
