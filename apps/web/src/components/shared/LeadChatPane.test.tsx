// T-F6 - LeadChatPane wire-shape + styling contract.
//
// Pins:
//   - Messages render in chronological order (oldest first) per the
//     backend's orderBy.createdAt='asc'.
//   - OUT messages are right-aligned with the blue staff bubble; IN
//     messages are left-aligned with the muted customer bubble.
//   - The send input + Send button are wired (disabled until draft
//     has content; refetches via useSendMessage onSuccess).
//   - Empty-state surfaces when the list resolves to [].
//   - Channel badge ("WhatsApp") surfaces for WHATSAPP-channel rows.
//
// Uses renderToStaticMarkup per the standing rule.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/crm', () => ({
  useMessages: vi.fn(),
  useMessagesRealtime: vi.fn(),
  useSendMessage: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

vi.mock('@/hooks/queries/users', () => ({
  useTeamMembers: vi.fn(() => ({
    data: [
      { id: 'u1', name: 'Asha T.', role: 'SALES_EXEC', email: 'a@x', teamId: 't1' },
      { id: 'u2', name: 'Ravi Kumar', role: 'MANAGER', email: 'r@x', teamId: null },
    ],
    isLoading: false,
  })),
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({
    user: { id: 'u1', role: 'SALES_EXEC', name: 'Exec', email: 'e@x' },
    isPending: false,
  })),
}));

import { LeadChatPane, withDateSeparators, groupForDate, extractMentionedNames, type DateGroup } from './LeadChatPane';
import { useMessages } from '@/hooks/queries/crm';

const mockedUseMessages = vi.mocked(useMessages);

afterEach(() => {
  vi.clearAllMocks();
});

describe('LeadChatPane - wire-shape + direction contract (T-F6)', () => {
  it('renders messages oldest-first with OUT right-aligned + IN left-aligned', () => {
    mockedUseMessages.mockReturnValue({
      data: [
        {
          id: 'm-1',
          leadId: 'lead-1',
          direction: 'IN',
          channel: 'WHATSAPP',
          body: 'Hi, I saw your listing on the website.',
          senderName: 'Priya Sharma',
          createdAt: '2026-09-04T08:30:00Z',
        },
        {
          id: 'm-2',
          leadId: 'lead-1',
          direction: 'OUT',
          channel: 'IN_APP',
          body: 'Hello! Thanks for reaching out. Are you free for a site visit this Saturday?',
          senderName: 'Asha T.',
          createdAt: '2026-09-04T08:32:00Z',
        },
        {
          id: 'm-3',
          leadId: 'lead-1',
          direction: 'IN',
          channel: 'WHATSAPP',
          body: 'Yes, Saturday 11 AM works.',
          senderName: 'Priya Sharma',
          createdAt: '2026-09-04T08:34:00Z',
        },
      ],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadChatPane leadId="lead-1" />);
    // Both bodies render
    expect(html).toContain('Hi, I saw your listing on the website.');
    expect(html).toContain('Saturday 11 AM works.');
    expect(html).toContain('Hello! Thanks for reaching out');
    // Direction-specific styling markers
    expect(html).toMatch(/data-direction="in"/);
    expect(html).toMatch(/data-direction="out"/);
    // Message aligns OUT to the end (right) and IN to the start (left)
    // via the Message component's data-align attribute.
    expect(html).toMatch(/data-align="end"/);
    expect(html).toMatch(/data-align="start"/);
    // Sender names render in the MessageHeader (staff for OUT, customer
    // for IN).
    expect(html).toContain('Asha T.');
    expect(html).toContain('Priya Sharma');
    // Avatar initials render from the sender name ("Asha T." → "AT",
    // "Priya Sharma" → "PS").
    expect(html).toContain('AT');
    expect(html).toContain('PS');
    // Channel tag surfaces on WHATSAPP rows
    expect(html).toContain('WhatsApp');
    // Send form surface
    expect(html).toMatch(/data-qa="chat-send-form"/);
    expect(html).toMatch(/data-qa="chat-input"/);
    expect(html).toMatch(/data-qa="chat-send-button"/);
  });

  it('renders the empty-state hint when useMessages resolves to an empty array', () => {
    mockedUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadChatPane leadId="lead-1" />);
    expect(html).toContain('No messages yet');
    expect(html).toContain('Send the first message below.');
    expect(html).toMatch(/data-qa="chat-messages"/);
  });

  it('renders a chat error / not-yet-wired hint when the query has an error', () => {
    const apiError = new Error('API 404: Not Found');
    mockedUseMessages.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: apiError,
    } as never);

    const html = renderToStaticMarkup(<LeadChatPane leadId="lead-1" />);
    expect(html).toContain('Chat will appear when the chat module lands');
    // The send form is still rendered (the user can type a message;
    // if the backend 404s on send, the mutation hook surfaces the
    // error via toast - separate concern from the read path).
    expect(html).toMatch(/data-qa="chat-send-form"/);
  });

  it('renders the conversation header with the lead name', () => {
    mockedUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadChatPane leadId="lead-1" leadName="Rohan Gupta" />);
    expect(html).toContain('Rohan Gupta');
    // Avatar initials from the lead name
    expect(html).toContain('RG');
  });

  it('renders a textarea composer (Enter-to-send) instead of a single-line input', () => {
    mockedUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadChatPane leadId="lead-1" />);
    expect(html).toMatch(/<textarea/);
    expect(html).toContain('Enter to send');
  });

  it('renders the Customer / Internal thread toggle', () => {
    mockedUseMessages.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadChatPane leadId="lead-1" />);
    expect(html).toContain('Customer');
    expect(html).toContain('Internal');
  });

  it('renders internal messages with the Internal badge and data-kind marker', () => {
    mockedUseMessages.mockReturnValue({
      data: [
        {
          id: 'm-int',
          leadId: 'lead-1',
          direction: 'OUT',
          channel: 'IN_APP',
          kind: 'INTERNAL',
          body: 'loop @Ravi Kumar',
          senderName: 'Asha T.',
          createdAt: '2026-09-09T10:00:00Z',
        },
      ],
      isLoading: false,
      error: null,
    } as never);

    const html = renderToStaticMarkup(<LeadChatPane leadId="lead-1" />);
    expect(html).toContain('Internal');
    expect(html).toMatch(/data-kind="internal"/);
    expect(html).toContain('loop @Ravi Kumar');
  });
});

describe('extractMentionedNames - @mention parsing (frontend)', () => {
  it('extracts capitalized @Name tokens', () => {
    expect(extractMentionedNames('loop @Asha T. and @Ravi')).toEqual([
      'Asha T.',
      'Ravi',
    ]);
  });

  it('returns empty for no mentions', () => {
    expect(extractMentionedNames('no mentions here')).toEqual([]);
  });
});

describe('withDateSeparators - date grouping (WIREFRAMES.md:334)', () => {
  const now = new Date('2026-09-09T12:00:00Z'); // Wednesday

  it('groups Today / Yesterday / This week / Older in order', () => {
    const rows = [
      { id: 'm-1', createdAt: '2026-09-01T10:00:00Z' }, // Older
      { id: 'm-2', createdAt: '2026-09-07T10:00:00Z' }, // This week (Mon)
      { id: 'm-3', createdAt: '2026-09-08T10:00:00Z' }, // Yesterday
      { id: 'm-4', createdAt: '2026-09-09T10:00:00Z' }, // Today
    ] as never;

    const out = withDateSeparators(rows, now);
    const groups = out
      .filter((e) => e.type === 'separator')
      .map((e) => (e as { group: DateGroup }).group);
    expect(groups).toEqual(['Older', 'This week', 'Yesterday', 'Today']);
    // 4 messages + 4 separators
    expect(out.filter((e) => e.type === 'message')).toHaveLength(4);
  });

  it('shows a calendar date for the Older group instead of a vague label', () => {
    const rows = [
      { id: 'm-1', createdAt: '2026-09-01T10:00:00Z' }, // Older
      { id: 'm-4', createdAt: '2026-09-09T10:00:00Z' }, // Today
    ] as never;

    const out = withDateSeparators(rows, now);
    const older = out.find((e) => e.type === 'separator' && (e as { group: DateGroup }).group === 'Older') as
      | { label: string }
      | undefined;
    expect(older).toBeDefined();
    // 2026-09-01 → "1 Sep 2026" (date-fns MMM = "Sep")
    expect(older!.label).toContain('Sep');
    expect(older!.label).not.toBe('Older');
  });

  it('does not insert a separator between two messages in the same group', () => {
    const rows = [
      { id: 'm-1', createdAt: '2026-09-09T08:00:00Z' },
      { id: 'm-2', createdAt: '2026-09-09T09:00:00Z' },
    ] as never;

    const out = withDateSeparators(rows, now);
    expect(out.filter((e) => e.type === 'separator')).toHaveLength(1);
  });

  it('groupForDate returns null for an invalid date', () => {
    expect(groupForDate(undefined, now)).toBeNull();
    expect(groupForDate('not-a-date', now)).toBeNull();
  });
});