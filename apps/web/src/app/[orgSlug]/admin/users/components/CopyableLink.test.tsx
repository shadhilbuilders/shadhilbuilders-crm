// CopyableLink (2026-11-20).
//
// This component's whole reason for existing is the path where
// `navigator.clipboard` is ABSENT (in-app webviews, which is exactly where a
// WhatsApp-shared link is opened). A test that only exercises the happy path
// would prove nothing about the case that matters, so the clipboard is deleted
// from the global in one case.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopyableLink } from './CopyableLink';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN_URL = 'https://crm.example.in/invite/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  // Restore whatever the environment had so cases cannot leak into each other.
  vi.unstubAllGlobals();
});

describe('CopyableLink - clipboard available', () => {
  it('copies the exact value and announces it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const el = mount(<CopyableLink value={TOKEN_URL} />);
    // The effect that detects the API runs after mount; re-render to pick it up.
    await act(async () => {
      await Promise.resolve();
    });

    const button = el.querySelector<HTMLButtonElement>('[data-qa="invite-link-copy-button"]');
    expect(button).not.toBeNull();

    await act(async () => {
      button!.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(TOKEN_URL);

    // The confirmation is announced, not merely painted: an unlabelled check
    // mark is invisible to a screen reader and to anyone glancing away.
    const live = el.querySelector('[role="status"][aria-live="polite"]');
    expect(live?.textContent).toContain('copied');
  });

  it('shows the link in full and never truncates it', () => {
    const el = mount(<CopyableLink value={TOKEN_URL} />);
    const input = el.querySelector<HTMLInputElement>('[data-qa="invite-link-input"]');
    expect(input?.value).toBe(TOKEN_URL);
    // The token must remain readable/copyable in full - it IS the credential.
    expect(input?.readOnly).toBe(true);
  });

  it('selects the text on focus, so long-press -> Select All works', () => {
    const el = mount(<CopyableLink value={TOKEN_URL} />);
    const input = el.querySelector<HTMLInputElement>('[data-qa="invite-link-input"]')!;
    input.focus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(TOKEN_URL.length);
  });
});

describe('CopyableLink - clipboard ABSENT (in-app webview)', () => {
  it('renders no copy button and explains the manual path instead', async () => {
    // Simulates a webview: no clipboard API at all.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });

    const el = mount(<CopyableLink value={TOKEN_URL} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(el.querySelector('[data-qa="invite-link-copy-button"]')).toBeNull();

    // A dead button is worse than none, so the fallback must be stated.
    expect(el.textContent).toContain('Long-press');
    // And the input must still be there and focusable - that IS the affordance.
    const input = el.querySelector<HTMLInputElement>('[data-qa="invite-link-input"]');
    expect(input).not.toBeNull();
    expect(input?.readOnly).toBe(true);
  });
});
