// Composer height contract for the WhatsApp inbox.
//
// Pins the one-line height of the composer. The library's Textarea ships
// `min-h-16` (64px) for form use; a chat composer at that height puts the
// placeholder at the top of the box with a dead ~30px strip underneath, which is
// exactly how this pane looked in production. The fix is the min-h/max-h pair on
// the textarea, and because cn() is twMerge the pair REPLACES the library default
// instead of stacking on it - so this test asserts both sides: our height is
// present AND `min-h-16` is gone. Drop the className and it comes straight back.
//
// jsdom has no layout, so the assertion is on the merged class list that
// renderToStaticMarkup produces. That string is what decides the height in the
// browser. Uses renderToStaticMarkup per the standing rule.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/crm', () => ({
  useMessages: vi.fn(() => ({ data: [], isLoading: false })),
  useContactMessages: vi.fn(() => ({ data: [], isLoading: false })),
  useMessagesRealtime: vi.fn(),
  useContactMessagesRealtime: vi.fn(),
  useSendMessage: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useSendContactMessage: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useMarkChatRead: vi.fn(() => ({ mutate: vi.fn() })),
  uploadChatMedia: vi.fn(),
}));

import { ChatThreadPanel } from './ChatThreadPanel';

// Window OPEN (the customer wrote a minute ago), otherwise the component renders
// the "24h window closed" notice and the composer never mounts.
const thread = {
  kind: 'LEAD' as const,
  id: 'lead-1',
  displayName: 'Asha',
  phoneE164: '+919000000000',
  linkedLeadId: null,
  lastInboundAt: new Date().toISOString(),
};

function composerClass(): string {
  const markup = renderToStaticMarkup(<ChatThreadPanel thread={thread} />);
  const tag = (markup.match(/<textarea\b[^>]*>/g) ?? []).find((t) =>
    t.includes('data-qa="composer"'),
  );
  if (!tag) throw new Error('composer textarea did not render');

  const cls = /class="([^"]*)"/.exec(tag)?.[1];
  if (!cls) throw new Error('composer textarea rendered without a class attribute');
  return cls;
}

describe('ChatThreadPanel composer height', () => {
  it('uses the 40px one-line height, with the library 64px default merged out', () => {
    const cls = composerClass();
    expect(cls).toContain('min-h-10');
    expect(cls).toContain('max-h-40');
    expect(cls).not.toContain('min-h-16');
  });

  it('keeps growing with the draft', () => {
    expect(composerClass()).toContain('field-sizing-content');
  });
});

// The freeform clock on the WhatsApp page (2026-11-27).
//
// protects= the countdown renders above the composer while the window is open and
//           is absent once it shuts, so an operator sees the clock on this page
//           and not only in the lead pane;
// fails_when= the countdown is dropped from this pane, or it renders while the
//           composer is replaced by the closed notice.
// note=   mounted rather than string-rendered: the clock starts empty on the
//         server on purpose (no hydration mismatch), so it only exists once the
//         effect has run, and only a real mount runs effects.
describe('the freeform countdown on the WhatsApp page', () => {
  const mount = (selected: typeof thread) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<ChatThreadPanel thread={selected} />));
    return {
      container,
      cleanup: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  };

  it('renders above the composer while the window is open', () => {
    const view = mount(thread);
    try {
      expect(view.container.querySelector('[data-qa="chat-window-remaining"]')).not.toBeNull();
      expect(view.container.textContent).toContain('Freeform replies close in');
    } finally {
      view.cleanup();
    }
  });

  it('is absent once the window has closed', () => {
    const stale = {
      ...thread,
      lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    const view = mount(stale);
    try {
      expect(view.container.querySelector('[data-qa="reply-window-closed"]')).not.toBeNull();
      expect(view.container.querySelector('[data-qa="chat-window-remaining"]')).toBeNull();
    } finally {
      view.cleanup();
    }
  });
});
