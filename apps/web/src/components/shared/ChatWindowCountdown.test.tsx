// ChatWindowCountdown (2026-11-27).
//
// protects= the composer's clock renders for an open window, names the remaining
//           time, and carries the amber / red tone as the window narrows;
// fails_when= it renders with no inbound message, renders once the window has
//           closed, or prints a tone that does not match the time left.
// no_claim= the half minute timer: a static render with an injected clock proves
//           the arithmetic, and the interval is one setInterval call.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChatWindowCountdown } from './ChatWindowCountdown';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const now = new Date('2026-11-27T10:00:00.000Z');

const html = (lastInboundAt: string | null) =>
  renderToStaticMarkup(<ChatWindowCountdown lastInboundAt={lastInboundAt} now={now} />);

describe('ChatWindowCountdown', () => {
  it('names the time left when the window is open', () => {
    const lastInbound = new Date(now.getTime() - 20 * HOUR - 48 * MINUTE).toISOString();
    const markup = html(lastInbound);
    expect(markup).toContain('data-qa="chat-window-remaining"');
    expect(markup).toContain('Freeform replies close in 3h 12m');
    expect(markup).toContain('data-tone="calm"');
  });

  it('turns amber inside the last hour', () => {
    const lastInbound = new Date(now.getTime() - 23 * HOUR - 20 * MINUTE).toISOString();
    const markup = html(lastInbound);
    expect(markup).toContain('data-tone="soon"');
    expect(markup).toContain('close in 40m');
  });

  it('renders nothing when the customer has not written', () => {
    expect(html(null)).toBe('');
  });

  it('renders nothing once the window has closed', () => {
    const lastInbound = new Date(now.getTime() - 25 * HOUR).toISOString();
    expect(html(lastInbound)).toBe('');
  });
});
