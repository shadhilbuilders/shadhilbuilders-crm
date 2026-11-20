// InviteStatusBadge (2026-11-20).
//
// The one rule worth pinning: EVERY status renders TEXT. Colour is decoration
// only, because a badge whose meaning lives in a hue is unreadable in
// greyscale, in sunlight, and to a colour-blind reader.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { InviteStatus } from '@shadhil/api-types';

import { InviteStatusBadge, INVITE_STATUS_LABELS } from './InviteStatusBadge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(status: InviteStatus): string {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<InviteStatusBadge status={status} />);
  });
  return (container.textContent ?? '').trim();
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('InviteStatusBadge', () => {
  const statuses: InviteStatus[] = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'];

  it('renders a human word for every status', () => {
    for (const status of statuses) {
      const text = render(status);
      expect(text, `status ${status} rendered no text`).toBe(INVITE_STATUS_LABELS[status]);
      expect(text.length).toBeGreaterThan(0);
      act(() => root?.unmount());
    }
  });

  it('never renders the raw enum value as the label', () => {
    // "PENDING" in the UI would read as a database leak, not a product.
    for (const status of statuses) {
      const text = render(status);
      expect(text).not.toBe(status);
      act(() => root?.unmount());
    }
  });

  it('distinguishes Expired from Pending by TEXT, not only colour', () => {
    // These two are the pair a reader most needs to tell apart, and they are
    // the two that would look identical if the label were dropped.
    const pending = render('PENDING');
    act(() => root?.unmount());
    const expired = render('EXPIRED');
    expect(pending).not.toBe(expired);
  });
});
