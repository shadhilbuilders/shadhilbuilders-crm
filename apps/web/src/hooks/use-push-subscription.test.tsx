// use-push-subscription - server-truth reconciliation for web push.
//
// The browser holding a PushSubscription proves nothing about the server: the
// row may have been pruned (404/410), dropped after a VAPID key rotation, or
// never written because the subscribe POST failed. The old hook trusted the
// browser alone, so a device could show "Enabled on this device" while receiving
// nothing, with no UI path back. These tests pin the reconciliation:
//
// protects=  a subscription the server cannot deliver to is never reported as
//            enabled; a missing row is healed by re-posting; a row under a
//            retired key is dropped and surfaced as "needs re-registering";
//            state is only claimed after the server confirms.
// fails_when= the badge says enabled while the server has no usable record, a
//            successful enable is reported before the POST lands, or a retired
//            subscription is left in place (subscribe() then throws
//            InvalidStateError).
// no_claim= does NOT exercise a real service worker, real VAPID signing, or the
//            backend; the browser push stack and the api client are faked.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
}));

vi.mock('@/apis/client', () => ({ api: mocks.api }));

import { usePushSubscription, type PushCapability } from './use-push-subscription';

function keyBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(65);
  bytes[0] = 4;
  for (let i = 1; i < bytes.length; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const CURRENT_KEY_BYTES = keyBytes(11);
const CURRENT_KEY = toBase64Url(CURRENT_KEY_BYTES);
const RETIRED_KEY_BYTES = keyBytes(97);

type FakeSubscription = {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  getKey: (name: string) => ArrayBuffer | null;
  unsubscribe: ReturnType<typeof vi.fn>;
};

function makeSubscription(applicationServerKey: ArrayBuffer | null): FakeSubscription {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
    options: { applicationServerKey },
    getKey: (name: string): ArrayBuffer =>
      (name === 'auth' ? new Uint8Array(16).fill(7) : new Uint8Array(65).fill(9)).buffer,
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

let currentSubscription: FakeSubscription | null = null;
let subscribe: ReturnType<typeof vi.fn>;

/** What `GET /push/status` answers, or 'error' to simulate the backend being down. */
type StatusReply = { registered: boolean; keyMatches: boolean } | 'error';
/** What `POST /push/subscribe` answers, or 'error' to simulate the write failing. */
type PostReply = { ok: true; keyMatches: boolean } | 'error';

let statusReply: StatusReply;
let postReply: PostReply;

function installBrowser(permission: NotificationPermission = 'granted'): void {
  subscribe = vi.fn(async (options: PushSubscriptionOptionsInit) => {
    const key = options.applicationServerKey as ArrayBuffer;
    currentSubscription = makeSubscription(key);
    return currentSubscription;
  });

  const registration = {
    active: {},
    pushManager: {
      getSubscription: vi.fn(async () => currentSubscription),
      subscribe,
    },
  };

  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: {},
      ready: Promise.resolve(registration),
      getRegistrations: async () => [registration],
    },
  });
  Object.defineProperty(window, 'PushManager', {
    configurable: true,
    value: function PushManager() {},
  });
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: { permission, requestPermission: vi.fn(async () => permission) },
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: PushCapability | null = null;

function Probe(): null {
  latest = usePushSubscription();
  return null;
}

async function renderHook(): Promise<PushCapability> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Probe));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return latest!;
}

beforeEach(() => {
  latest = null;
  currentSubscription = null;
  statusReply = { registered: true, keyMatches: true };
  postReply = { ok: true, keyMatches: true };
  mocks.api.mockImplementation(async (path: string) => {
    if (path === '/push/vapid-key') return { publicKey: CURRENT_KEY };
    if (path.startsWith('/push/status')) {
      if (statusReply === 'error') throw new Error('backend unreachable');
      return statusReply;
    }
    if (path === '/push/subscribe') {
      if (postReply === 'error') throw new Error('write failed');
      return postReply;
    }
    return undefined;
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  delete (window as { PushManager?: unknown }).PushManager;
});

describe('usePushSubscription - reconciles with the server on mount', () => {
  it('reports subscribed only when the server holds the endpoint under the current key', async () => {
    installBrowser();
    currentSubscription = makeSubscription(CURRENT_KEY_BYTES.slice().buffer);

    const capability = await renderHook();

    expect(capability.isSupported).toBe(true);
    expect(capability.isSubscribed).toBe(true);
    expect(capability.needsRepair).toBe(false);
    expect(mocks.api).toHaveBeenCalledWith(
      expect.stringContaining(
        `/push/status?endpoint=${encodeURIComponent(currentSubscription.endpoint)}`,
      ),
    );
    expect(mocks.api).not.toHaveBeenCalledWith('/push/subscribe', expect.anything());
    expect(currentSubscription.unsubscribe).not.toHaveBeenCalled();
  });

  it('heals a missing row by re-posting a subscription whose key still matches', async () => {
    // This is the "device shows enabled, table is empty" case: the row was
    // pruned on 404/410 or the original POST never landed.
    installBrowser();
    currentSubscription = makeSubscription(CURRENT_KEY_BYTES.slice().buffer);
    statusReply = { registered: false, keyMatches: false };

    const capability = await renderHook();

    expect(mocks.api).toHaveBeenCalledWith(
      '/push/subscribe',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(capability.isSubscribed).toBe(true);
    expect(capability.needsRepair).toBe(false);
  });

  it('drops a subscription registered under a retired key and asks for a re-register', async () => {
    installBrowser();
    currentSubscription = makeSubscription(RETIRED_KEY_BYTES.slice().buffer);
    statusReply = { registered: true, keyMatches: false };

    const capability = await renderHook();

    expect(currentSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(capability.isSupported).toBe(true);
    expect(capability.isSubscribed).toBe(false);
    expect(capability.needsRepair).toBe(true);
  });

  it('does not post a retired-key subscription back to the server', async () => {
    installBrowser();
    currentSubscription = makeSubscription(RETIRED_KEY_BYTES.slice().buffer);
    statusReply = { registered: false, keyMatches: false };

    await renderHook();

    // Re-posting it would recreate a row that can never be delivered to.
    expect(mocks.api).not.toHaveBeenCalledWith('/push/subscribe', expect.anything());
  });

  it('trusts the browser when the status call fails, rather than calling a working device broken', async () => {
    installBrowser();
    currentSubscription = makeSubscription(CURRENT_KEY_BYTES.slice().buffer);
    statusReply = 'error';

    const capability = await renderHook();

    expect(capability.isSubscribed).toBe(true);
    expect(capability.needsRepair).toBe(false);
  });

  it('treats an unreadable applicationServerKey as a match (Safari)', async () => {
    installBrowser();
    currentSubscription = makeSubscription(null);

    const capability = await renderHook();

    expect(currentSubscription.unsubscribe).not.toHaveBeenCalled();
    expect(capability.isSubscribed).toBe(true);
  });

  it('stays not-subscribed when the browser has no subscription at all', async () => {
    installBrowser();

    const capability = await renderHook();

    expect(capability.isSupported).toBe(true);
    expect(capability.isSubscribed).toBe(false);
    expect(capability.needsRepair).toBe(false);
    // No endpoint to ask about, so no status round trip either.
    expect(
      mocks.api.mock.calls.filter(([path]) => String(path).startsWith('/push/status')),
    ).toHaveLength(0);
  });
});

describe('usePushSubscription - enablePush never claims more than the server has', () => {
  it('does not report success when registering an existing subscription fails', async () => {
    installBrowser();
    currentSubscription = makeSubscription(CURRENT_KEY_BYTES.slice().buffer);
    await renderHook();
    postReply = 'error';

    let enabled = true;
    await act(async () => {
      enabled = await latest!.enablePush();
    });

    expect(enabled).toBe(false);
    expect(latest!.isSubscribed).toBe(false);
    expect(latest!.needsRepair).toBe(true);
  });

  it('replaces a retired-key subscription instead of reporting success', async () => {
    installBrowser();
    currentSubscription = makeSubscription(RETIRED_KEY_BYTES.slice().buffer);
    statusReply = { registered: true, keyMatches: false };
    await renderHook();
    mocks.api.mockClear();

    let enabled = false;
    await act(async () => {
      enabled = await latest!.enablePush();
    });

    expect(enabled).toBe(true);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(
      toBase64Url(new Uint8Array(subscribe.mock.calls[0]![0].applicationServerKey as ArrayBuffer)),
    ).toBe(CURRENT_KEY);
    expect(mocks.api).toHaveBeenCalledWith(
      '/push/subscribe',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('confirms registration with the server when the subscription already matches', async () => {
    installBrowser();
    currentSubscription = makeSubscription(CURRENT_KEY_BYTES.slice().buffer);
    await renderHook();
    mocks.api.mockClear();

    let enabled = false;
    await act(async () => {
      enabled = await latest!.enablePush();
    });

    expect(enabled).toBe(true);
    expect(subscribe).not.toHaveBeenCalled();
    // The key lookup plus the confirmation POST; no new subscription.
    expect(mocks.api).toHaveBeenCalledWith(
      '/push/subscribe',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('usePushSubscription - reRegister', () => {
  it('drops the stale subscription, subscribes fresh, and registers it', async () => {
    installBrowser();
    const stale = makeSubscription(RETIRED_KEY_BYTES.slice().buffer);
    currentSubscription = stale;
    statusReply = { registered: true, keyMatches: false };
    await renderHook();
    // The mount reconciliation already dropped it once (retired key).
    expect(stale.unsubscribe).toHaveBeenCalledTimes(1);

    let repaired = false;
    await act(async () => {
      repaired = await latest!.reRegister();
    });

    // reRegister clears whatever the browser still holds before subscribing:
    // reusing a live subscription returns the SAME endpoint, which after a
    // rotation can never become deliverable.
    expect(stale.unsubscribe).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(
      toBase64Url(new Uint8Array(subscribe.mock.calls[0]![0].applicationServerKey as ArrayBuffer)),
    ).toBe(CURRENT_KEY);
    expect(repaired).toBe(true);
    expect(latest!.isSubscribed).toBe(true);
    expect(latest!.needsRepair).toBe(false);
  });

  it('reports failure and keeps needsRepair when the register POST fails', async () => {
    installBrowser();
    currentSubscription = makeSubscription(RETIRED_KEY_BYTES.slice().buffer);
    statusReply = { registered: false, keyMatches: false };
    await renderHook();
    postReply = 'error';

    let repaired = true;
    await act(async () => {
      repaired = await latest!.reRegister();
    });

    expect(repaired).toBe(false);
    expect(latest!.isSubscribed).toBe(false);
    expect(latest!.needsRepair).toBe(true);
  });
});
