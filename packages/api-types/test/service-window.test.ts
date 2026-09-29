// WhatsApp 24h customer-service window - the shared contract (T-WA-WINDOW, 2026-09-29).
//
// This rule decides whether a staff message can reach the customer AT ALL, and
// it is used from three places that must agree: the API's send guard, the lead
// chat pane's composer, and the whatsapp-chat pane's composer. It lives here as
// one definition for the same reason TokenAmountSchema does - the previous
// duplication (a local copy inside ChatThreadPanel) is exactly the kind of split
// that lets the UI offer a send the server refuses.
//
// THE FACT THE WHOLE FEATURE RESTS ON: Meta opens the window when the CUSTOMER
// messages the business. Meta's docs: "When a WhatsApp user messages you or
// calls you, a 24-hour timer called a customer service window starts". The
// business sending a TEMPLATE does NOT open it, and neither does the customer
// merely receiving one. So a thread with no customer reply has a CLOSED window
// no matter how many templates went out, and freeform text sent then is rejected
// by Meta with 131047 (re-engagement message) - after the app has already
// accepted it and the cron has already tried.
import { describe, expect, it } from 'vitest';

import {
  AWAITING_CUSTOMER_REPLY_MESSAGE,
  CLOSED_WINDOW_MESSAGE,
  isServiceWindowOpen,
  SendWelcomeMessageDtoSchema,
  serviceWindowExpiry,
  WHATSAPP_SERVICE_WINDOW_MS,
} from '../src/chat';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

describe('isServiceWindowOpen - Meta 24h customer-service window', () => {
  it('is OPEN just after the customer writes', () => {
    expect(isServiceWindowOpen(new Date(NOW.getTime() - 60_000), NOW)).toBe(true);
  });

  it('is OPEN at 23h59m and CLOSED at 24h01m', () => {
    // The boundary is the whole rule, so it is pinned from both sides. The
    // window is 24h from the customer's message, inclusive of the instant it
    // expires is not assumed - 1ms past is closed.
    expect(isServiceWindowOpen(new Date(NOW.getTime() - (24 * HOUR - 60_000)), NOW)).toBe(true);
    expect(isServiceWindowOpen(new Date(NOW.getTime() - (24 * HOUR + 60_000)), NOW)).toBe(false);
  });

  it('is CLOSED when the customer has never written', () => {
    // The load-bearing case for this feature: a brand-new lead the business has
    // templated but who has never replied. Sending a template does NOT open the
    // window, so this must be false even if a template went out a minute ago.
    expect(isServiceWindowOpen(null, NOW)).toBe(false);
    expect(isServiceWindowOpen(undefined, NOW)).toBe(false);
  });

  it('is CLOSED (not OPEN) for an unparseable timestamp', () => {
    // Fail closed: the cost of guessing "open" is a message the customer never
    // receives, announced to the operator as sent.
    expect(isServiceWindowOpen('not-a-date', NOW)).toBe(false);
    expect(isServiceWindowOpen('', NOW)).toBe(false);
  });

  it('accepts both an ISO string (wire) and a Date (server)', () => {
    const iso = new Date(NOW.getTime() - HOUR).toISOString();
    expect(isServiceWindowOpen(iso, NOW)).toBe(true);
    expect(isServiceWindowOpen(new Date(NOW.getTime() - HOUR), NOW)).toBe(true);
  });

  it('uses exactly 24 hours', () => {
    expect(WHATSAPP_SERVICE_WINDOW_MS).toBe(86_400_000);
  });
});

describe('serviceWindowExpiry', () => {
  it('returns the customer-inbound instant + 24h', () => {
    const last = new Date('2026-09-29T10:00:00.000Z');
    expect(serviceWindowExpiry(last)).toEqual(
      new Date('2026-09-30T10:00:00.000Z'),
    );
  });

  it('returns null when there is no window to expire', () => {
    expect(serviceWindowExpiry(null)).toBeNull();
    expect(serviceWindowExpiry(undefined)).toBeNull();
    expect(serviceWindowExpiry('nonsense')).toBeNull();
  });
});

describe('SendWelcomeMessageDto', () => {
  it('requires a cuid2 leadId', () => {
    expect(SendWelcomeMessageDtoSchema.safeParse({ leadId: 'abc123def456ghi789jkl0' }).success).toBe(true);
    expect(SendWelcomeMessageDtoSchema.safeParse({ leadId: 'not-an-id' }).success).toBe(false);
    expect(SendWelcomeMessageDtoSchema.safeParse({}).success).toBe(false);
  });
});

describe('window copy', () => {
  it('names the real cause so the operator can act', () => {
    // "Cannot send" without a reason trains people to retry, which is what the
    // closed-window state exists to prevent.
    expect(CLOSED_WINDOW_MESSAGE).toContain('24-hour');
    expect(CLOSED_WINDOW_MESSAGE).toContain('customer');
    expect(AWAITING_CUSTOMER_REPLY_MESSAGE).toMatch(/opens when the customer replies/i);
  });
});
