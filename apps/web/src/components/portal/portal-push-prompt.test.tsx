// PortalPushPrompt (issue #8 slice 2, AC9).
//
// protects= a buyer who CAN receive push is offered it exactly once, from a
//           user gesture, and the card disappears after enabling or dismissing;
// fails_when= the prompt fires with no capability, re-appears after dismissal,
//           is shown to an already-subscribed device, requests permission
//           without a click, or renders for a browser that cannot push;
// no_claim= does NOT prove a PushSubscription row is written (that needs a
//           real service worker + browser) nor that PortalNotifier then finds
//           the recipient (customer-portal-rls.test.ts owns that query).
//
// Same harness as push-enable-prompt.test.tsx: createRoot + act, no
// @testing-library (not a dependency of this app).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  usePushSubscription: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/use-push-subscription', () => ({
  usePushSubscription: mocks.usePushSubscription,
}));

vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, toast: mocks.toast };
});

import { PortalPushPrompt } from './portal-push-prompt';

const DISMISS_KEY = 'shadhil:portal-push-dismissed';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

type Capability = {
  checked: boolean;
  isSupported: boolean;
  isSubscribed: boolean;
  permission: NotificationPermission;
  enablePush: () => Promise<boolean>;
};

function setCapability(over: Partial<Capability> = {}): void {
  mocks.usePushSubscription.mockReturnValue({
    checked: true,
    isSupported: true,
    isSubscribed: false,
    permission: 'default',
    enablePush: vi.fn(async () => true),
    ...over,
  });
}

function mount(): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<PortalPushPrompt />);
  });
  return container;
}

function unmount(): void {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
}

const prompt = (el: HTMLElement): Element | null =>
  el.querySelector('[data-qa="portal-push-prompt"]');
const button = (el: HTMLElement, qa: string): HTMLButtonElement | null =>
  el.querySelector<HTMLButtonElement>(`[data-qa="${qa}"]`);

beforeEach(() => {
  window.localStorage.clear();
  setCapability();
});

afterEach(() => {
  unmount();
  vi.clearAllMocks();
});

describe('PortalPushPrompt capability gates', () => {
  it('renders the offer when the browser can push and this device is not subscribed', () => {
    const el = mount();
    expect(prompt(el)).not.toBeNull();
    expect(el.textContent).toContain('Get a notification when new photos arrive');
  });

  it('fails_when= a browser that cannot push is still offered it', () => {
    setCapability({ isSupported: false });
    expect(prompt(mount())).toBeNull();
  });

  it('fails_when= capability has not resolved yet (never flashes the card)', () => {
    setCapability({ checked: false });
    expect(prompt(mount())).toBeNull();
  });

  it('fails_when= an already-subscribed device is asked again', () => {
    setCapability({ isSubscribed: true });
    expect(prompt(mount())).toBeNull();
  });
});

describe('PortalPushPrompt behaviour', () => {
  it('protects= enabling happens on a user gesture, then the card goes away', async () => {
    const el = mount();
    const enable = button(el, 'portal-push-enable');
    expect(enable).not.toBeNull();
    const capability = mocks.usePushSubscription.mock.results[0]?.value as Capability;
    expect(capability.enablePush).not.toHaveBeenCalled(); // no permission request on mount

    await act(async () => {
      enable?.click();
    });

    expect(capability.enablePush).toHaveBeenCalledTimes(1);
    expect(prompt(el)).toBeNull();
    expect(window.localStorage.getItem(DISMISS_KEY)).toBe('v1');
    expect(mocks.toast.success).toHaveBeenCalled();
  });

  it('dismissal is durable: the latch survives a remount', () => {
    const first = mount();
    const dismiss = button(first, 'portal-push-dismiss');
    expect(dismiss).not.toBeNull();
    act(() => {
      dismiss?.click();
    });
    expect(prompt(first)).toBeNull();
    unmount();

    expect(prompt(mount())).toBeNull();
  });

  it('fails_when= a denied permission dead-ends the buyer (guidance + retry label)', async () => {
    setCapability({ permission: 'denied', enablePush: vi.fn(async () => false) });
    const el = mount();
    await act(async () => {
      button(el, 'portal-push-enable')?.click();
    });
    expect(el.textContent).toContain('blocked for this site');
    expect(button(el, 'portal-push-enable')?.textContent).toContain('Try again');
    // Still dismissible - a blocked buyer must be able to clear the card.
    expect(button(el, 'portal-push-dismiss')).not.toBeNull();
  });

  it('a transient failure keeps the card so the buyer can retry', async () => {
    setCapability({ enablePush: vi.fn(async () => false) });
    const el = mount();
    await act(async () => {
      button(el, 'portal-push-enable')?.click();
    });
    expect(prompt(el)).not.toBeNull();
    expect(window.localStorage.getItem(DISMISS_KEY)).toBeNull();
  });
});

// An iPhone/iPad in a browser tab has no push API at all (iOS hides `Notification`
// outside a Home Screen web app), so the card used to render nothing and the
// buyer was never told why they get no alerts. The install hint is the offer.
describe('PortalPushPrompt on iOS', () => {
  const IPHONE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

  afterEach(() => {
    delete (navigator as { userAgent?: unknown }).userAgent;
  });

  it('asks the buyer to add the page to the Home Screen instead of staying silent', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: IPHONE_UA });
    setCapability({ isSupported: false });

    const el = mount();

    expect(prompt(el)).not.toBeNull();
    expect(el.textContent).toContain('Add this page to your Home Screen');
    expect(el.textContent).toContain('Add to Home Screen');
    expect(button(el, 'portal-push-enable')).toBeNull();
  });

  it('the acknowledgement latches under its own key, not the push-dismiss key', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: IPHONE_UA });
    setCapability({ isSupported: false });

    const el = mount();
    act(() => {
      button(el, 'portal-push-install-ack')?.click();
    });

    expect(window.localStorage.getItem('shadhil:push-ios-install-dismissed')).toBe('v1');
    expect(window.localStorage.getItem(DISMISS_KEY)).toBeNull();
    expect(prompt(el)).toBeNull();
  });
});
