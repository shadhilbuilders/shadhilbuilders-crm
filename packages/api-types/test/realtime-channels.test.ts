// Realtime channel vocabulary - T-WA-INBOX contact threads (2026-11-21).
//
// The regression this pins: the WhatsApp inbox opened its SSE stream on
// `chat:<contactId>`. A contactId is a cuid, so `parseChannel` accepted it and
// the mint reached the backend, which then looked for a LEAD with that id,
// found none, and threw 403. `openStream` re-mints on every backoff retry, so
// the loop drained the per-user ticket budget (10/min, 60/hour) that the
// app-wide `notifications` stream shares - opening one unknown-number thread
// starved notification realtime everywhere.
//
// The contract these tests fix in place:
//   1. `chat-contact:<contactId>` parses as its OWN kind, never as a lead.
//   2. Each kind maps to exactly one SSE path (the hook builds it, the
//      service matches it - drift between the two is the bug class).
//   3. Malformed ids are rejected rather than silently accepted, so a typo
//      fails at the type boundary instead of becoming a 403 loop.
import { describe, expect, it } from 'vitest';

import {
  contactChatChannel,
  leadChatChannel,
  parseChannel,
  ssePathForChannel,
} from '../src/realtime';

// cuid2-shaped: 'c' + 24 lowercase alphanumerics (matches CUID_RE).
const ID = 'ckw4v7t9b0001abcd2efghij';
const OTHER_ID = 'ckw4v7t9b0002zzzz9yyyyyy';

describe('parseChannel - fixed vocabulary', () => {
  it('parses the two singleton channels', () => {
    expect(parseChannel('notifications')).toEqual({ kind: 'notifications' });
    expect(parseChannel('audit')).toEqual({ kind: 'audit' });
  });

  it('parses a lead chat channel', () => {
    expect(parseChannel(leadChatChannel(ID))).toEqual({ kind: 'chat', leadId: ID });
  });

  it('parses a contact chat channel as its own kind', () => {
    // The whole point: this must NOT come back as { kind: 'chat' }.
    expect(parseChannel(contactChatChannel(ID))).toEqual({
      kind: 'chat-contact',
      contactId: ID,
    });
  });

  it('rejects an unknown channel', () => {
    expect(parseChannel('chatty')).toBeNull();
    expect(parseChannel('')).toBeNull();
  });

  it('rejects a chat channel whose id is not cuid-shaped', () => {
    // A bad id must fail here, at the boundary - not survive to a 403 loop.
    expect(parseChannel('chat:lead-1')).toBeNull();
    expect(parseChannel('chat-contact:contact-1')).toBeNull();
  });

  it('rejects a contact channel with a missing id', () => {
    expect(parseChannel('chat-contact:')).toBeNull();
  });
});

describe('channel builders', () => {
  it('round-trips through parseChannel for both thread kinds', () => {
    const lead = parseChannel(leadChatChannel(ID));
    const contact = parseChannel(contactChatChannel(ID));

    expect(lead?.kind).toBe('chat');
    expect(contact?.kind).toBe('chat-contact');
  });

  it('produces distinguishable strings for the same id', () => {
    // Same id in both builders must not collide: they are different threads.
    expect(leadChatChannel(ID)).not.toBe(contactChatChannel(ID));
  });
});

describe('ssePathForChannel - hook and service agree on the URL', () => {
  it('maps a lead channel to /chat/<id>', () => {
    expect(ssePathForChannel(leadChatChannel(ID))).toBe(`/chat/${ID}`);
  });

  it('maps a contact channel to /chat-contact/<id>', () => {
    expect(ssePathForChannel(contactChatChannel(ID))).toBe(`/chat-contact/${ID}`);
  });

  it('maps the singleton channels to /<name>', () => {
    expect(ssePathForChannel('notifications')).toBe('/notifications');
    expect(ssePathForChannel('audit')).toBe('/audit');
  });

  it('keeps two different contact ids on different paths', () => {
    expect(ssePathForChannel(contactChatChannel(ID))).not.toBe(
      ssePathForChannel(contactChatChannel(OTHER_ID)),
    );
  });

  it('falls back to /<channel> for an unparseable channel', () => {
    // Defensive only - callers build channels through the builders above.
    expect(ssePathForChannel('weird')).toBe('/weird');
  });
});
