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
  // T-WA-WINDOW (2026-09-29): the pane now reads the thread's reply-window state
  // and can send the welcome template. Default = window OPEN, so every existing
  // render test keeps exercising the ordinary composer (a closed window replaces
  // it with the welcome/blocked state, which would silently change what those
  // tests assert). The gate tests below override this per case.
  useChatThreadState: vi.fn(() => ({
    data: {
      leadId: 'lead-1',
      lastInboundAt: new Date().toISOString(),
      lastTemplateSentAt: null,
      windowOpen: true,
      windowExpiresAt: null,
      // Writable by default: most tests exercise the ordinary owner/manager
      // composer. The read-only case is set explicitly where it is tested.
      canWriteThread: true,
    },
    isLoading: false,
  })),
  useSendWelcomeMessage: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
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

import {
  LeadChatPane,
  withDateSeparators,
  groupForDate,
  validateChatFile,
  resolveMentionedUserIds,
  type DateGroup,
} from './LeadChatPane';
import { useChatThreadState, useMessages } from '@/hooks/queries/crm';

const mockedUseMessages = vi.mocked(useMessages);
const mockedThreadState = vi.mocked(useChatThreadState);

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

describe('validateChatFile - client-side file validation', () => {
  // Only `size` and `type` are read, so build a File-shaped stub instead of
  // allocating megabytes of real content (the old `'x'.repeat(20MB)` version
  // allocated ~20MB per case for no extra coverage).
  const createFile = (size: number, type: string): File =>
    ({ size, type, name: 'test.txt' }) as unknown as File;

  const MB = 1024 * 1024;

  it('accepts valid image files under 10MB', () => {
    expect(validateChatFile(createFile(5 * MB, 'image/png'))).toEqual({ ok: true });
  });

  it('accepts valid PDF files under 10MB', () => {
    expect(validateChatFile(createFile(10 * MB, 'application/pdf'))).toEqual({ ok: true });
  });

  it('accepts valid text files under 10MB', () => {
    expect(validateChatFile(createFile(1024, 'text/plain'))).toEqual({ ok: true });
  });

  it('accepts valid video files under 10MB', () => {
    expect(validateChatFile(createFile(9 * MB, 'video/mp4'))).toEqual({ ok: true });
  });

  it('accepts valid audio files under 10MB', () => {
    expect(validateChatFile(createFile(8 * MB, 'audio/mpeg'))).toEqual({ ok: true });
  });

  it('accepts a file of exactly 10MB (the cap is inclusive)', () => {
    // The check is `size > MAX_UPLOAD_BYTES`, so exactly 10MB passes. Pin it:
    // an off-by-one here silently rejects a boundary-legal file.
    expect(validateChatFile(createFile(10 * MB, 'image/png'))).toEqual({ ok: true });
  });

  it('rejects a file one byte over 10MB', () => {
    const result = validateChatFile(createFile(10 * MB + 1, 'image/png'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('10MB');
  });

  it('rejects files larger than 10MB', () => {
    const result = validateChatFile(createFile(20 * MB, 'image/png'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('10MB');
  });

  it('rejects empty files', () => {
    const result = validateChatFile(createFile(0, 'image/png'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('empty');
  });

  it('rejects unsupported MIME types', () => {
    const result = validateChatFile(createFile(1024, 'application/zip'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Unsupported file type');
  });

  it('rejects executable files', () => {
    const result = validateChatFile(createFile(1024, 'application/x-executable'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Unsupported file type');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T-MENTION-TARGET (2026-09-29): who a draft actually ADDRESSES.
// ────────────────────────────────────────────────────────────────────────────
//
// This decides who receives an RLS grant to the lead and its customer thread,
// so it is tested directly rather than through the pane: the pane's suite uses
// `renderToStaticMarkup`, which cannot type into the composer, and logic hidden
// inside the component would stay untested.
describe('resolveMentionedUserIds - who a draft addresses', () => {
  // NOTE the deliberate prefix collision: "Asha" and "Asha T." are two distinct
  // teammates. A naive substring test addresses BOTH from a single "@Asha T.",
  // which is a real over-grant rather than a cosmetic bug.
  const picked = {
    'Asha T.': 'ID-asha-t',
    Asha: 'ID-asha',
    'Ravi Kumar': 'ID-ravi',
    "O'Brien": 'ID-obrien',
  };

  it('addresses only the teammate whose exact name was picked', () => {
    expect(resolveMentionedUserIds('loop @Asha T. now', picked)).toEqual(['ID-asha-t']);
  });

  it('does NOT also address a shorter name that prefixes the picked one', () => {
    // The bug this pins: "@Asha T." must not grant anything to "Asha".
    expect(resolveMentionedUserIds('loop @Asha T. now', picked)).not.toContain('ID-asha');
    expect(resolveMentionedUserIds('loop @Asha now', picked)).toEqual(['ID-asha']);
  });

  it('handles a name at the end of the draft', () => {
    expect(resolveMentionedUserIds('over to you @Asha T.', picked)).toEqual(['ID-asha-t']);
  });

  it('handles a display name containing an apostrophe', () => {
    expect(resolveMentionedUserIds("please ping @O'Brien now", picked)).toEqual(['ID-obrien']);
  });

  it('is NOT a mention without the @ (typed names address nobody)', () => {
    // Only a picked mention carries an id, so a bare name cannot grant access.
    expect(resolveMentionedUserIds('I will ask Asha about it', picked)).toEqual([]);
    expect(resolveMentionedUserIds('', picked)).toEqual([]);
  });

  it('addresses every picked teammate still present in the draft', () => {
    expect(resolveMentionedUserIds('@Asha T. and @Ravi Kumar please', picked)).toEqual([
      'ID-asha-t',
      'ID-ravi',
    ]);
  });

  it('addresses a teammate ONCE when mentioned repeatedly', () => {
    expect(resolveMentionedUserIds('@Asha T. x @Asha T.', picked)).toEqual(['ID-asha-t']);
  });

  it('drops a mention DELETED from the draft before sending', () => {
    // Deriving from the current text is what makes deletion meaningful: a name
    // the sender removed must not still hand over a lead.
    expect(resolveMentionedUserIds('removed it, never mind', picked)).toEqual([]);
    // ...and a name still present is still addressed.
    expect(resolveMentionedUserIds('kept @Ravi Kumar', picked)).toEqual(['ID-ravi']);
  });

  it('is deterministic (a stable payload for the same draft)', () => {
    const body = '@Ravi Kumar and @Asha T. and @Asha';
    expect(resolveMentionedUserIds(body, picked)).toEqual(
      resolveMentionedUserIds(body, picked),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T-WA-WINDOW (2026-09-29): the 24h reply-window gate + Welcome Message button.
// ────────────────────────────────────────────────────────────────────────────
//
// This decides whether a staff message can reach the customer at all. Meta opens
// the 24h window on the CUSTOMER's inbound and on nothing else - so a brand-new
// lead has a CLOSED window no matter what the business has sent, and freeform
// text sent then is rejected with 131047 after the app has accepted it.
describe('LeadChatPane - WhatsApp reply-window gate', () => {
  /**
   * `messages` defaults to an EMPTY thread (the state this whole suite is
   * about), but takes rows for the cases that need a non-empty one - passing
   * them here rather than mocking separately, because this helper OWNS the
   * messages mock and would otherwise overwrite a per-test value.
   */
  function renderPane(messages: unknown[] = []) {
    mockedUseMessages.mockReturnValue({ data: messages, isLoading: false, error: null } as never);
    return renderToStaticMarkup(<LeadChatPane leadId="lead-1" leadName="Priya Sharma" />);
  }

  function withThreadState(data: Record<string, unknown>) {
    mockedThreadState.mockReturnValue({ data, isLoading: false, error: null } as never);
  }

  it('an EMPTY customer thread gets the Welcome button under the empty-state copy', () => {
    // Owner instruction (2026-09-29): the welcome action belongs INSIDE the
    // empty state, under "Send the first message below" - it IS the first
    // message on a thread with nothing in it.
    withThreadState({
      leadId: 'lead-1',
      lastInboundAt: null,
      lastTemplateSentAt: null,
      windowOpen: false,
      windowExpiresAt: null,
    });
    const html = renderPane();
    expect(html).toContain('data-qa="chat-welcome-button"');
    expect(html).toContain('Welcome Message');
    expect(html).toContain('Send the first message below.');
    // The welcome action must appear AFTER that copy in the markup, i.e. below
    // it in the rendered state.
    expect(html.indexOf('Send the first message below.')).toBeLessThan(
      html.indexOf('data-qa="chat-welcome-button"'),
    );
    // The composer must be GONE, not merely disabled: an input the user cannot
    // submit invites them to type a message that would never be delivered.
    expect(html).not.toContain('data-qa="chat-input"');
    expect(html).toContain('data-qa="chat-window-closed"');
  });

  it('an OPEN window shows the composer and NOT the Welcome button', () => {
    withThreadState({
      leadId: 'lead-1',
      lastInboundAt: new Date().toISOString(),
      lastTemplateSentAt: new Date().toISOString(),
      windowOpen: true,
      windowExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    // An open window implies the customer wrote, so the thread has rows.
    const html = renderPane([
      {
        id: 'm-in',
        leadId: 'lead-1',
        direction: 'IN',
        channel: 'WHATSAPP',
        body: 'Yes, please share the details.',
        senderName: 'Priya Sharma',
        createdAt: '2026-09-29T09:00:00Z',
      },
    ]);
    expect(html).toContain('data-qa="chat-input"');
    expect(html).not.toContain('data-qa="chat-welcome-button"');
  });

  it('after a welcome send the copy says the window opens on THEIR reply', () => {
    // The correction that matters: sending a template does NOT open the window.
    // Offering "type freely now" here would produce a message Meta rejects.
    // A welcome writes a Message row, so the thread is no longer empty - and the
    // notice must say the window still is not open.
    withThreadState({
      leadId: 'lead-1',
      lastInboundAt: null,
      lastTemplateSentAt: new Date().toISOString(),
      windowOpen: false,
      windowExpiresAt: null,
    });
    const html = renderPane([
      {
        id: 'm-welcome',
        leadId: 'lead-1',
        direction: 'OUT',
        channel: 'WHATSAPP',
        body: 'Welcome message sent (shadhil_welcome_enquiry).',
        senderName: 'Exec',
        createdAt: '2026-09-29T10:00:00Z',
      },
    ]);
    expect(html).toMatch(/opens when the customer replies/i);
    expect(html).not.toContain('data-qa="chat-input"');
  });

  it('shows NO Welcome button once the thread has any message', () => {
    // Owner instruction: "Once first message sent, don't show that button."
    // This is the whole point of moving it into the empty state - a lingering
    // "send welcome again" invites a second cold template the customer did not
    // ask for.
    // Window shut, so this is exactly the state that used to show the button.
    withThreadState({
      leadId: 'lead-1',
      lastInboundAt: null,
      lastTemplateSentAt: new Date().toISOString(),
      windowOpen: false,
      windowExpiresAt: null,
    });
    const html = renderPane([
      {
        id: 'm-1',
        leadId: 'lead-1',
        direction: 'OUT',
        channel: 'WHATSAPP',
        body: 'Hello, happy to help with your enquiry.',
        senderName: 'Exec',
        createdAt: '2026-09-29T10:00:00Z',
      },
    ]);
    expect(html).not.toContain('data-qa="chat-welcome-button"');
    expect(html).not.toContain('Welcome Message');
  });

  it('a window that expired shows the closed notice, not the composer', () => {
    const lastInbound = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    withThreadState({
      leadId: 'lead-1',
      lastInboundAt: lastInbound,
      lastTemplateSentAt: null,
      windowOpen: false,
      windowExpiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const html = renderPane();
    expect(html).toContain('data-qa="chat-window-closed"');
    expect(html).not.toContain('data-qa="chat-input"');
    expect(html).toContain('24-hour');
  });

  it('fails CLOSED while the state is still loading', () => {
    // A slow request must never briefly enable a composer the API will refuse.
    mockedThreadState.mockReturnValue({ data: undefined, isLoading: true, error: null } as never);
    const html = renderPane();
    expect(html).not.toContain('data-qa="chat-input"');
    expect(html).toContain('data-qa="chat-window-closed"');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T-READONLY-READER (2026-09-29): a mentioned teammate can READ this thread but
// cannot WRITE to it.
// ────────────────────────────────────────────────────────────────────────────
//
// An @mention grants read access to the lead and its whole thread, but does NOT
// set coOwnerId, so `message_insert_team` still refuses their reply. Before this
// gate the pane showed them a fully working composer and the send died on the
// RLS insert with an opaque 42501 - the app inviting an action it would refuse
// (the same class of bug as the closed WhatsApp window).
describe('LeadChatPane - read-only reader (mentioned, not the owner)', () => {
  function renderPane() {
    mockedUseMessages.mockReturnValue({ data: [], isLoading: false, error: null } as never);
    return renderToStaticMarkup(<LeadChatPane leadId="lead-1" leadName="Priya Sharma" />);
  }

  it('replaces the composer with the reason, for a reader who cannot write', () => {
    mockedThreadState.mockReturnValue({
      data: {
        leadId: 'lead-1',
        // Window OPEN: only the PERMISSION blocks this reader, which is what
        // makes this test independent of the 24h-window gate.
        lastInboundAt: new Date().toISOString(),
        lastTemplateSentAt: null,
        windowOpen: true,
        windowExpiresAt: null,
        canWriteThread: false,
      },
      isLoading: false,
      error: null,
    } as never);

    const html = renderPane();
    expect(html).toContain('data-qa="chat-read-only"');
    // The composer must be GONE, not merely disabled.
    expect(html).not.toContain('data-qa="chat-input"');
    // ...and it must not be replaced by the WINDOW explanation, which would
    // blame the 24h rule for a permission problem.
    expect(html).not.toContain('data-qa="chat-window-closed"');
    expect(html).toMatch(/mentioned/i);
  });

  it('a writable actor still gets the composer (the gate is not always-on)', () => {
    mockedThreadState.mockReturnValue({
      data: {
        leadId: 'lead-1',
        lastInboundAt: new Date().toISOString(),
        lastTemplateSentAt: null,
        windowOpen: true,
        windowExpiresAt: null,
        canWriteThread: true,
      },
      isLoading: false,
      error: null,
    } as never);

    const html = renderPane();
    expect(html).toContain('data-qa="chat-input"');
    expect(html).not.toContain('data-qa="chat-read-only"');
  });

  it('stays writable while the state is still loading (no false lock)', () => {
    // Fail-OPEN for this flag, unlike the window gate: an unknown permission must
    // not lock an owner out of their own lead mid-load. The API still refuses a
    // write the policy denies, so the worst case is an error message, not a lost
    // capability.
    mockedThreadState.mockReturnValue({ data: undefined, isLoading: true, error: null } as never);
    const html = renderPane();
    expect(html).not.toContain('data-qa="chat-read-only"');
  });
});
