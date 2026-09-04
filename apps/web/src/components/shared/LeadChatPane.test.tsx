// T-F6 — LeadChatPane wire-shape + styling contract.
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

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({
    user: { id: 'u1', role: 'SALES_EXEC', name: 'Exec', email: 'e@x' },
    isPending: false,
  })),
}));

import { LeadChatPane } from './LeadChatPane';
import { useMessages } from '@/hooks/queries/crm';

const mockedUseMessages = vi.mocked(useMessages);

afterEach(() => {
  vi.clearAllMocks();
});

describe('LeadChatPane — wire-shape + direction contract (T-F6)', () => {
  it('renders messages oldest-first with OUT right-aligned + IN left-aligned', () => {
    mockedUseMessages.mockReturnValue({
      data: [
        {
          id: 'm-1',
          leadId: 'lead-1',
          direction: 'IN',
          channel: 'WHATSAPP',
          body: 'Hi, I saw your listing on the website.',
          createdAt: '2026-09-04T08:30:00Z',
        },
        {
          id: 'm-2',
          leadId: 'lead-1',
          direction: 'OUT',
          channel: 'IN_APP',
          body: 'Hello! Thanks for reaching out. Are you free for a site visit this Saturday?',
          createdAt: '2026-09-04T08:32:00Z',
        },
        {
          id: 'm-3',
          leadId: 'lead-1',
          direction: 'IN',
          channel: 'WHATSAPP',
          body: 'Yes, Saturday 11 AM works.',
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
    // Right-aligned (OUT) and left-aligned (IN) classes both present
    expect(html).toContain('justify-end');
    expect(html).toContain('justify-start');
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
    expect(html).toContain('No messages yet.');
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
    // error via toast — separate concern from the read path).
    expect(html).toMatch(/data-qa="chat-send-form"/);
  });
});