// WhatsApp chat inbox (T-WA-INBOX) - web-layer tests.
//
// These pin the pure logic the two-pane UI depends on:
//   - replyWindowState: the 24h Meta reply window (the composer's block)
//   - conversationTime / conversationPreview: the list row rendering
//   - toSelection: the API row -> chat-panel selection mapping
//
// The panels themselves are network-driven; the pure decisions are what a
// regression would silently break (e.g. a closed window letting a send through
// to fail invisibly in the outbound cron).

// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  conversationPreview,
  conversationTime,
  toSelection,
} from '@/components/whatsapp/ChatConversationList';
import { replyWindowState } from '@/components/whatsapp/ChatThreadPanel';

describe('replyWindowState - the 24h WhatsApp reply window', () => {
  const now = new Date('2026-09-25T12:00:00Z');

  it('is open 23h after the customer last wrote', () => {
    const state = replyWindowState('2026-09-24T13:00:00Z', now);
    expect(state.open).toBe(true);
    expect(state.expiresAt?.toISOString()).toBe('2026-09-25T13:00:00.000Z');
  });

  it('is closed 25h after the customer last wrote', () => {
    expect(replyWindowState('2026-09-24T11:00:00Z', now).open).toBe(false);
  });

  it('treats exactly-24h as closed (Meta would reject the send)', () => {
    expect(replyWindowState('2026-09-24T12:00:00Z', now).open).toBe(false);
  });

  it('is closed when the customer has never written (no window to reply into)', () => {
    const state = replyWindowState(null, now);
    expect(state.open).toBe(false);
    expect(state.expiresAt).toBeNull();
  });

  it('is closed for an unparseable timestamp rather than assumed open', () => {
    // Failing closed matters: the alternative lets a send through that the
    // outbound cron then drops without the operator seeing anything.
    expect(replyWindowState('not-a-date', now).open).toBe(false);
  });
});

describe('conversationPreview - the one-line list preview', () => {
  it('leaves an inbound message unprefixed', () => {
    expect(conversationPreview('Is the villa available?', 'IN')).toBe(
      'Is the villa available?',
    );
  });

  it('prefixes our own last message with "You:" so direction is readable', () => {
    expect(conversationPreview('on our way', 'OUT')).toBe('You: on our way');
  });

  it('shows "Attachment" for a media-only message', () => {
    expect(conversationPreview('   ', 'IN')).toBe('Attachment');
    expect(conversationPreview('', 'OUT')).toBe('You: Attachment');
  });
});

describe('conversationTime - list timestamp', () => {
  it('returns a non-empty, capitalized reading for a real timestamp', () => {
    const out = conversationTime('2026-09-25T10:03:00Z');
    expect(out.length).toBeGreaterThan(0);
    // The library lowercases day prefixes ("today at 10:03"); the cell
    // capitalizes the first letter so it reads as a sentence.
    expect(out.charAt(0)).toBe(out.charAt(0).toUpperCase());
  });

  it('falls back to the app-wide placeholder for an unparseable value', () => {
    // lib/format.ts configures dateIntl with fallback '-', so a bad value
    // renders the placeholder rather than "Invalid Date".
    expect(conversationTime('nonsense')).toBe('-');
  });
});

describe('toSelection - API row -> chat panel selection', () => {
  const row = {
    threadKind: 'LEAD' as const,
    threadId: 'lead-1',
    threadKey: 'LEAD:lead-1',
    displayName: 'Asha Menon',
    phoneE164: '919000000111',
    linkedLeadId: 'lead-1',
    lastInboundAt: '2026-09-25T09:55:00Z',
  };

  it('carries identity + the inbound timestamp the window logic needs', () => {
    const sel = toSelection(row, 'shadhil-builders');
    expect(sel).toMatchObject({
      kind: 'LEAD',
      id: 'lead-1',
      displayName: 'Asha Menon',
      phoneE164: '919000000111',
      lastInboundAt: '2026-09-25T09:55:00Z',
    });
  });

  it('omits leadHref entirely when no project slug is known', () => {
    // An href that cannot be honoured is worse than no link: the lead page is
    // /{org}/projects/{project}/leads/{id} and a bare org path would 404.
    const sel = toSelection(row, 'shadhil-builders');
    expect(sel.leadHref).toBeUndefined();
    expect('leadHref' in sel).toBe(false);
  });

  it('builds the full lead href when the project slug is known', () => {
    const sel = toSelection(row, 'shadhil-builders', 'shadhil-metro-heights');
    expect(sel.leadHref).toBe(
      '/shadhil-builders/projects/shadhil-metro-heights/leads/lead-1',
    );
  });

  it('never links a CONTACT thread to a lead page', () => {
    const sel = toSelection(
      { ...row, threadKind: 'CONTACT', threadId: 'contact-9', linkedLeadId: null },
      'shadhil-builders',
      'shadhil-metro-heights',
    );
    expect(sel.kind).toBe('CONTACT');
    expect(sel.leadHref).toBeUndefined();
  });
});
