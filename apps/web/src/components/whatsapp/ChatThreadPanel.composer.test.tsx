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
