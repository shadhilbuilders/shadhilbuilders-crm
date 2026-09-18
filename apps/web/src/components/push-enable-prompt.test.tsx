// PushEnablePrompt - consent dialog for enabling web push.
//
// Pins the gating logic: the dialog only opens when push is supported, not
// already subscribed, and not dismissed. Once dismissed, it stays closed for
// the session. We mock the AlertDialog + usePushSubscription so no browser
// push API or real dialog is exercised.
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  usePushSubscription: vi.fn(),
  AlertDialog: vi.fn((_props: {
    open?: boolean;
    header?: { title?: string; description?: string };
    onConfirm?: (arg: unknown) => void;
    onCancel?: () => void;
    onOpenChange?: (open: boolean) => void;
  }): ReactNode | null => null),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/use-push-subscription', () => ({
  usePushSubscription: mocks.usePushSubscription,
}));

vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, AlertDialog: mocks.AlertDialog, toast: mocks.toast };
});

import { PushEnablePrompt } from './push-enable-prompt';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PushEnablePrompt />);
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
}

function basePush(overrides: Partial<ReturnType<typeof mocks.usePushSubscription>['_']> = {}) {
  return {
    isSupported: true,
    isSubscribed: false,
    checked: true,
    permission: 'default' as NotificationPermission,
    enablePush: vi.fn(async () => true),
    ...overrides,
  };
}

afterEach(async () => {
  await unmount();
  vi.clearAllMocks();
  try {
    window.sessionStorage.clear();
  } catch {
    // jsdom in some setups lacks sessionStorage; the prompt's safeGetItem/
    // safeSetItem already guard against this.
  }
});

describe('PushEnablePrompt - consent gating', () => {
  it('opens the dialog when push is supported + not subscribed + not dismissed', async () => {
    mocks.usePushSubscription.mockReturnValue(basePush());
    await mount();
    expect(mocks.AlertDialog).toHaveBeenCalled();
    const props = mocks.AlertDialog.mock.calls.at(-1)?.[0];
    expect(props).toBeDefined();
    expect(props?.open).toBe(true);
    expect(props?.header?.title).toContain('Enable notifications');
  });

  it('stays closed when push is unsupported', async () => {
    mocks.usePushSubscription.mockReturnValue(basePush({ isSupported: false }));
    await mount();
    const props = mocks.AlertDialog.mock.calls.at(-1)?.[0];
    expect(props?.open).toBe(false);
  });

  it('stays closed when already subscribed', async () => {
    mocks.usePushSubscription.mockReturnValue(basePush({ isSubscribed: true }));
    await mount();
    const props = mocks.AlertDialog.mock.calls.at(-1)?.[0];
    expect(props?.open).toBe(false);
  });

  it('does not open after a prior dismissal this session', async () => {
    window.sessionStorage.setItem('shadhil:push-prompt-dismissed', '1');
    mocks.usePushSubscription.mockReturnValue(basePush());
    await mount();
    // Session-scoped dismissal: with the flag set, the dialog stays closed.
    const props = mocks.AlertDialog.mock.calls.at(-1)?.[0];
    expect(props?.open).toBe(false);
  });

  it('enabling calls enablePush and closes the dialog on success', async () => {
    const enablePush = vi.fn(async () => true);
    mocks.usePushSubscription.mockReturnValue(basePush({ enablePush }));
    await mount();

    // Grab the onConfirm from the props the dialog received and call it.
    const props = mocks.AlertDialog.mock.calls.at(-1)?.[0];
    await act(async () => props?.onConfirm?.({}));

    expect(enablePush).toHaveBeenCalled();
    const lastCall = mocks.AlertDialog.mock.calls.at(-1)?.[0];
    expect(lastCall?.open).toBe(false);
    expect(mocks.toast.success).toHaveBeenCalledWith('Push notifications enabled');
  });

  it('on a denied permission, switches to blocked guidance and keeps the dialog open', async () => {
    // push.enablePush() fails AND the permission is now 'denied' - the browser
    // will never re-prompt, so the dialog must switch to a "blocked" guidance
    // state (NOT close with a dead-end error toast).
    const enablePush = vi.fn(async () => false);
    mocks.usePushSubscription.mockReturnValue(
      basePush({ permission: 'denied', enablePush }),
    );
    await mount();

    const props = mocks.AlertDialog.mock.calls.at(-1)?.[0];
    await act(async () => props?.onConfirm?.({}));

    // Still open, re-titled to guidance, error toast NOT fired.
    const lastCall = mocks.AlertDialog.mock.calls.at(-1)?.[0];
    expect(lastCall?.open).toBe(true);
    expect(lastCall?.header?.title).toContain('Notifications are blocked');
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it('completes when the user returns and re-confirms after fixing the block', async () => {
    // After the block is fixed in browser settings, permission flips to
    // 'granted'. The confirm button now reads "I've enabled it" - clicking it
    // re-runs enablePush (which now succeeds) and closes with success.
    const state: { permission: NotificationPermission; ok: [boolean, boolean] } = {
      permission: 'denied',
      ok: [false, true],
    };
    const enablePush = vi.fn(async (): Promise<boolean> => state.ok.shift() ?? false);
    mocks.usePushSubscription.mockImplementation(() => ({
      isSupported: true,
      isSubscribed: false,
      checked: true,
      permission: state.permission,
      enablePush,
    }));

    await mount();

    // Attempt 1: denied -> switches to blocked guidance (stays open).
    let props = mocks.AlertDialog.mock.calls.at(-1)?.[0];
    await act(async () => props?.onConfirm?.({}));
    expect(mocks.AlertDialog.mock.calls.at(-1)?.[0]?.header?.title).toContain(
      'Notifications are blocked',
    );
    expect(mocks.AlertDialog.mock.calls.at(-1)?.[0]?.open).toBe(true);

    // User fixes it, returns, and confirms the (now-successful) attempt.
    state.permission = 'granted';
    props = mocks.AlertDialog.mock.calls.at(-1)?.[0];
    await act(async () => props?.onConfirm?.({}));

    expect(mocks.toast.success).toHaveBeenCalledWith('Push notifications enabled');
    expect(mocks.AlertDialog.mock.calls.at(-1)?.[0]?.open).toBe(false);
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});
