// push-install-guidance - the platform gate behind the install hint.
//
// The rule being pinned (Apple docs + WebKit blog): on iOS/iPadOS the Push API
// and the `Notification` interface exist ONLY inside a Home Screen web app. In a
// Safari tab every one of those globals is missing, so "enable notifications"
// can never work there and the only honest offer is "add to Home Screen first".
// jsdom has none of the push globals by default, which makes it a fair stand-in
// for an iOS tab; the installed-app case is faked on top of it.
import { afterEach, describe, expect, it } from 'vitest';

import {
  canPageUseWebPush,
  isIosDevice,
  isStandaloneWebApp,
  needsIosHomeScreenInstall,
} from './push-install-guidance';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
// iPadOS 13+ sends a Macintosh UA. A real Mac has no touch points.
const IPADOS_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

function installPushGlobals(): void {
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: function Notification() {},
  });
  Object.defineProperty(window, 'PushManager', {
    configurable: true,
    value: function PushManager() {},
  });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} });
}

afterEach(() => {
  delete (window as { Notification?: unknown }).Notification;
  delete (window as { PushManager?: unknown }).PushManager;
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  delete (navigator as { standalone?: unknown }).standalone;
});

describe('isIosDevice', () => {
  it('recognises iPhone and iPad user agents', () => {
    expect(isIosDevice(IPHONE_UA, 5)).toBe(true);
    expect(isIosDevice(IPAD_UA, 5)).toBe(true);
  });

  it('recognises iPadOS 13+ by its Macintosh UA plus multi-touch', () => {
    expect(isIosDevice(IPADOS_DESKTOP_UA, 5)).toBe(true);
  });

  it('does not treat a Mac or an Android phone as iOS', () => {
    expect(isIosDevice(MAC_UA, 0)).toBe(false);
    expect(isIosDevice(ANDROID_UA, 5)).toBe(false);
  });
});

describe('canPageUseWebPush', () => {
  it('is false when the push globals are absent (every iOS browser tab)', () => {
    expect(canPageUseWebPush()).toBe(false);
  });

  it('is true once Notification, PushManager and serviceWorker all exist', () => {
    installPushGlobals();
    expect(canPageUseWebPush()).toBe(true);
  });
});

describe('needsIosHomeScreenInstall', () => {
  it('is true for an iPhone in a Safari tab', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: IPHONE_UA });
    expect(needsIosHomeScreenInstall()).toBe(true);
  });

  it('is false once the site is running as the installed Home Screen app', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: IPHONE_UA });
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    expect(isStandaloneWebApp()).toBe(true);
    expect(needsIosHomeScreenInstall()).toBe(false);
  });

  it('is false on Android and desktop, where push needs no install', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ANDROID_UA });
    expect(needsIosHomeScreenInstall()).toBe(false);
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: MAC_UA });
    expect(needsIosHomeScreenInstall()).toBe(false);
  });
});
