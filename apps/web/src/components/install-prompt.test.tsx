// InstallPrompt - install affordance dedupe.
//
// Pins the bug: Chromium re-emits `beforeinstallprompt` (on every hard
// navigation, and repeatedly while an install is pending), and the old
// handler created a NEW sonner toast for every event. Because those toasts
// carry `duration: Infinity`, each extra event left another identical
// install banner stacked on screen until reload.
//
// The contract now: at most ONE install prompt per browser session, a stable
// sonner id so a repeat event replaces rather than appends, and no prompt at
// all once the app is installed.
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  // Typed parameters (not a bare `vi.fn()`) so `mock.calls.at(-1)` is typed as
  // [ReactNode, options?] and the assertions on the toast id type-check.
  toast: Object.assign(
    vi.fn((_content: unknown, _options?: { id?: string }) => 'install-toast-id'),
    { dismiss: vi.fn() }
  ),
  Button: vi.fn(
    ({
      children,
      onClick,
      variant: _variant,
      size: _size,
      ...rest
    }: {
      children?: ReactNode;
      onClick?: () => void;
      variant?: string;
      size?: string;
    } & Record<string, unknown>): ReactNode => (
      <button type="button" onClick={onClick} {...(rest as object)}>
        {children}
      </button>
    )
  ),
}));

vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, Button: mocks.Button, toast: mocks.toast };
});

import { InstallPrompt } from './install-prompt';

const SHOWN_KEY = 'shadhil:install-prompt-shown';
const INSTALLED_KEY = 'shadhil:install-prompt-installed';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
// The toast content is rendered imperatively by sonner, not by our component.
// To exercise the Install / Dismiss buttons we render the captured JSX into
// its own root, exactly as sonner would.
let toastContainer: HTMLDivElement | null = null;
let toastRoot: Root | null = null;

/**
 * localStorage is polyfilled globally for apps/web tests in
 * `src/test/idb-setup.ts` (jsdom exposes sessionStorage but NOT localStorage
 * here, because Node's built-in shadows it without `--localstorage-file`).
 * This wrapper just makes the availability explicit at each use site.
 */
function requireLocalStorage(): Storage {
  return window.localStorage;
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<InstallPrompt />);
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
    toastRoot?.unmount();
  });
  root = null;
  toastRoot = null;
  container?.remove();
  container = null;
  toastContainer?.remove();
  toastContainer = null;
}

async function renderLastToastContent(): Promise<HTMLDivElement> {
  const call = mocks.toast.mock.calls.at(-1);
  const content = call?.[0] as ReactNode;
  toastContainer = document.createElement('div');
  document.body.appendChild(toastContainer);
  toastRoot = createRoot(toastContainer);
  await act(async () => {
    toastRoot?.render(content);
  });
  return toastContainer;
}

type FakePromptEvent = Event & {
  platforms: string[];
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

function makePromptEvent(outcome: 'accepted' | 'dismissed' = 'dismissed'): FakePromptEvent {
  // `cancelable: true` matters: the component calls preventDefault() to
  // suppress Chromium's own mini-infobar, and preventDefault() is a no-op on a
  // non-cancelable event, leaving defaultPrevented false in jsdom.
  const evt = new Event('beforeinstallprompt', {
    cancelable: true,
  }) as FakePromptEvent;
  evt.platforms = ['web'];
  evt.prompt = vi.fn(async () => undefined);
  evt.userChoice = Promise.resolve({ outcome, platform: 'web' });
  return evt;
}

async function fireInstallPrompt(
  outcome: 'accepted' | 'dismissed' = 'dismissed'
): Promise<FakePromptEvent> {
  const evt = makePromptEvent(outcome);
  await act(async () => {
    window.dispatchEvent(evt);
  });
  return evt;
}

beforeEach(() => {
  // Fail loudly if the global polyfill from src/test/idb-setup.ts ever goes
  // missing, rather than letting the component's safeGet silently no-op.
  expect(requireLocalStorage()).toBeDefined();
  // jsdom has no matchMedia; the component must tolerate its absence and it
  // must report "not installed" by default.
  window.matchMedia = vi.fn(
    () =>
      ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList
  );
});

afterEach(async () => {
  await unmount();
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('InstallPrompt - Samsung Internet userChoice hang', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dismisses the toast as soon as prompt() resolves, without waiting on userChoice', async () => {
    await mount();

    // Samsung Internet calls prompt() fine but never settles userChoice -
    // https://stackoverflow.com/questions/59878575. Model that: prompt()
    // resolves, userChoice hangs forever.
    const evt = makePromptEvent();
    evt.userChoice = new Promise(() => undefined);
    await act(async () => {
      window.dispatchEvent(evt);
    });

    const rendered = await renderLastToastContent();
    const install = Array.from(rendered.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Install')
    );

    await act(async () => {
      install?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // Let the microtask queue (prompt() resolution) flush without
      // depending on the never-resolving userChoice promise.
      await Promise.resolve();
    });

    expect(evt.prompt).toHaveBeenCalledTimes(1);
    // Dismissed immediately after prompt() resolved - not stuck forever
    // waiting on userChoice.
    expect(mocks.toast.dismiss).toHaveBeenCalled();

    // Fast-forward past the userChoice timeout; this must not throw or hang
    // the test, and must not mark the app installed (we never learned the
    // real outcome).
    await act(async () => {
      vi.advanceTimersByTime(10000);
      await Promise.resolve();
    });

    expect(window.localStorage.getItem(INSTALLED_KEY)).toBeNull();
  });
});

describe('InstallPrompt - dedupe', () => {
  it('shows at most one prompt when the browser re-emits the event', async () => {
    await mount();

    await fireInstallPrompt();
    await fireInstallPrompt();
    await fireInstallPrompt();

    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it('uses a stable toast id so a repeat event replaces instead of stacking', async () => {
    await mount();

    await fireInstallPrompt();

    const options = mocks.toast.mock.calls.at(-1)?.[1] as { id?: string };
    expect(options?.id).toBeTruthy();
    expect(typeof options.id).toBe('string');
  });

  it('does not prompt again in the same session after a dismissal', async () => {
    await mount();

    await fireInstallPrompt();
    const rendered = await renderLastToastContent();
    const dismiss = rendered.querySelector('button[aria-label="Dismiss"]');
    expect(dismiss).not.toBeNull();
    await act(async () => {
      dismiss?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.toast.dismiss).toHaveBeenCalled();

    await fireInstallPrompt();

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(SHOWN_KEY)).toBeTruthy();
  });

  it('stays silent when the app is already running standalone', async () => {
    window.matchMedia = vi.fn(
      () =>
        ({
          matches: true,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList
    );
    await mount();

    await fireInstallPrompt();

    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('stays silent once the app has been installed', async () => {
    window.localStorage.setItem(INSTALLED_KEY, '1');
    await mount();

    await fireInstallPrompt();

    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('calls prompt() on Install and records acceptance', async () => {
    await mount();

    const evt = await fireInstallPrompt('accepted');
    const rendered = await renderLastToastContent();
    const install = Array.from(rendered.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Install')
    );
    expect(install).toBeDefined();

    await act(async () => {
      install?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await evt.userChoice;
    });

    expect(evt.prompt).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(INSTALLED_KEY)).toBe('1');
    expect(mocks.toast.dismiss).toHaveBeenCalled();
  });

  it('stops prompting after the appinstalled event', async () => {
    await mount();
    await fireInstallPrompt();

    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'));
    });

    expect(window.localStorage.getItem(INSTALLED_KEY)).toBe('1');
    expect(mocks.toast.dismiss).toHaveBeenCalled();
  });

  it('still prevents the browser mini-infobar on every event', async () => {
    await mount();

    const first = await fireInstallPrompt();
    const second = await fireInstallPrompt();

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
  });
});
