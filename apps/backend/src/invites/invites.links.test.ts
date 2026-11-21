// Invite link derivation (2026-11-20).
//
// The `wa.me` URL is the feature's primary delivery path, and it fails
// SILENTLY when wrong: a `+` in the path 404s rather than erroring, so a bad
// link looks like a working one until a staff member taps it. These tests pin
// the exact shape.
import { describe, expect, it } from 'vitest';

import {
  buildInviteLinks,
  buildInviteMessage,
  buildInviteUrl,
  buildWhatsappUrl,
} from './invites.links';

describe('buildInviteUrl', () => {
  it('joins the app origin and token', () => {
    expect(buildInviteUrl('https://crm.example.in', 'abc123')).toBe(
      'https://crm.example.in/invite/abc123',
    );
  });

  it('does not double the slash when the origin has a trailing one', () => {
    expect(buildInviteUrl('https://crm.example.in/', 'abc')).toBe(
      'https://crm.example.in/invite/abc',
    );
    expect(buildInviteUrl('https://crm.example.in///', 'abc')).toBe(
      'https://crm.example.in/invite/abc',
    );
  });
});

describe('buildWhatsappUrl', () => {
  it('uses the digits-only form (the stored shape)', () => {
    expect(buildWhatsappUrl('919876543210', 'hi')).toBe('https://wa.me/919876543210?text=hi');
  });

  it('STRIPS a plus sign, which would silently 404', () => {
    // The whole reason this is derived server-side rather than templated in
    // the client: wa.me rejects `+` in the path without an error.
    const url = buildWhatsappUrl('+919876543210', 'hi');
    expect(url).toBe('https://wa.me/919876543210?text=hi');
    expect(url).not.toContain('+91');
  });

  it('strips spaces and punctuation defensively', () => {
    expect(buildWhatsappUrl('+91 98765 43210', 'hi')).toBe('https://wa.me/919876543210?text=hi');
  });

  it('uses https (not whatsapp://) so it also works on desktop', () => {
    expect(buildWhatsappUrl('919876543210', 'hi')).toMatch(/^https:\/\//);
  });

  it('percent-encodes the message, including newlines and ampersands', () => {
    const url = buildWhatsappUrl('919876543210', 'line one\nline two & more');
    expect(url).toContain('%0A'); // newline encoded
    expect(url).toContain('%26'); // ampersand encoded, not a query separator
    expect(url).not.toContain('\n');
  });
});

describe('buildInviteMessage', () => {
  const base = {
    name: 'Ramesh Kumar',
    organizationName: 'Shadhil Builders',
    inviteUrl: 'https://crm.example.in/invite/tok',
  };

  it('greets by first name only - a full legal name reads automated', () => {
    const msg = buildInviteMessage(base);
    expect(msg).toContain('Hi Ramesh,');
    expect(msg).not.toContain('Ramesh Kumar,');
  });

  it('names the org, so an unattributed link is not indistinguishable from phishing', () => {
    expect(buildInviteMessage(base)).toContain('Shadhil Builders');
  });

  it('carries the full invite URL', () => {
    expect(buildInviteMessage(base)).toContain('https://crm.example.in/invite/tok');
  });

  it('handles a single-token name without producing "Hi undefined"', () => {
    const msg = buildInviteMessage({ ...base, name: 'Ramesh' });
    expect(msg).toContain('Hi Ramesh,');
    expect(msg).not.toContain('undefined');
  });

  it('handles surrounding whitespace', () => {
    const msg = buildInviteMessage({ ...base, name: '  Ramesh   Kumar  ' });
    expect(msg).toContain('Hi Ramesh,');
  });

  it('keeps an apostrophe or non-ASCII name intact (it is text, not markup)', () => {
    // Encoding happens at the URL layer; the message itself must not mangle
    // a name. A stripped apostrophe would read as a bug to the recipient.
    const msg = buildInviteMessage({ ...base, name: "D'Souza Ravi" });
    expect(msg).toContain("Hi D'Souza,");
    const tamil = buildInviteMessage({ ...base, name: 'ரமேஷ் குமார்' });
    expect(tamil).toContain('ரமேஷ்');
  });
});

describe('buildInviteLinks', () => {
  it('returns all three consistently from one token', () => {
    const links = buildInviteLinks({
      appUrl: 'https://crm.example.in',
      rawToken: 'tok_abc',
      phone: '919876543210',
      name: 'Ramesh Kumar',
      organizationName: 'Shadhil Builders',
    });

    expect(links.inviteUrl).toBe('https://crm.example.in/invite/tok_abc');
    // The URL embedded in the message must be the SAME one returned.
    expect(links.messageText).toContain(links.inviteUrl);
    // And the wa.me link must encode that same message.
    expect(links.whatsappUrl).toBe(
      `https://wa.me/919876543210?text=${encodeURIComponent(links.messageText)}`,
    );
  });
});
