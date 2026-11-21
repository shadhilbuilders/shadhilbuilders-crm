// use-push-subscription - VAPID key-rotation behaviour.
//
// After the deployed pair is rotated, every browser subscription still carries
// the OLD applicationServerKey. The push service rejects sends against it with a
// 403 (VapidPkHashMismatch), which is neither 404 nor 410, so the backend never
// prunes the row - the device silently stops receiving push while the UI still
// says "subscribed". The hook must therefore compare the subscription's key with
// the one the server serves now, drop a stale one, and let the enable path
// rebuild it. jsdom has no service worker or push stack, so all of it is faked.
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
  mocks.api.mockImplementation(async (path: string) =>
    path === '/push/vapid-key' ? { publicKey: CURRENT_KEY } : undefined,
  );
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

describe('usePushSubscription - VAPID key rotation', () => {
  it('keeps a subscription that was created with the current key', async () => {
    installBrowser();
    currentSubscription = makeSubscription(CURRENT_KEY_BYTES.slice().buffer);

    const capability = await renderHook();

    expect(capability.isSupported).toBe(true);
    expect(capability.isSubscribed).toBe(true);
    expect(currentSubscription.unsubscribe).not.toHaveBeenCalled();
  });

  it('drops a subscription bound to a retired key so the device can re-subscribe', async () => {
    installBrowser();
    currentSubscription = makeSubscription(RETIRED_KEY_BYTES.slice().buffer);

    const capability = await renderHook();

    expect(currentSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(capability.isSupported).toBe(true);
    // Nothing is registered server-side for the new key yet, so the prompt /
    // Settings enable button must be offered again.
    expect(capability.isSubscribed).toBe(false);
  });

  it('treats an unreadable applicationServerKey as a match (Safari)', async () => {
    installBrowser();
    currentSubscription = makeSubscription(null);

    const capability = await renderHook();

    expect(currentSubscription.unsubscribe).not.toHaveBeenCalled();
    expect(capability.isSubscribed).toBe(true);
  });

  it('enablePush replaces a retired-key subscription instead of reporting success', async () => {
    installBrowser();
    currentSubscription = makeSubscription(RETIRED_KEY_BYTES.slice().buffer);
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

  it('enablePush is a no-op when the subscription already uses the current key', async () => {
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
    // The key lookup itself is expected; registering the subscription again is not.
    expect(mocks.api).not.toHaveBeenCalledWith('/push/subscribe', expect.anything());
  });
});
