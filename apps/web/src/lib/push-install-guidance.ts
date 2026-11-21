'use client';

// Where is web push actually available, and what does iOS need first?
//
// The platform rule that drives this file (verified against Apple's developer
// docs and the WebKit blog): on iOS and iPadOS, Web Push and even the
// `Notification` interface exist ONLY inside a Home Screen web app. In a Safari
// tab `Notification` is undefined and `PushManager` is unusable, so a "Turn on
// notifications" button can never work there - iOS 16.4+ gates the whole feature
// behind Share -> Add to Home Screen, and the permission request then has to run
// from a gesture inside the installed app.
//
// Consequence in this codebase: `usePushSubscription` correctly reports
// `isSupported: false` in an iOS tab, which meant `PushEnablePrompt` and
// `PortalPushPrompt` both rendered nothing at all - the user saw silence and
// concluded notifications were broken. These helpers let the prompts recognise
// that case and point at the install instead of staying mute.
//
// iOS 26 changed the ADD flow (every Home Screen site opens as a web app by
// default, with an "Open as Web App" switch), not the requirement: a site still
// has to be on the Home Screen before it can ask for notification permission.

/** Storage latch for the install hint. Shared by both prompts, versioned so bumping re-offers. */
export const IOS_INSTALL_HINT_KEY = 'shadhil:push-ios-install-dismissed';
export const IOS_INSTALL_HINT_VERSION = 'v1';

/** Minimum iOS version that supports Web Push at all (iOS/iPadOS 16.4). */
export const IOS_PUSH_MIN_VERSION = '16.4';

const IOS_USER_AGENT = /iPhone|iPad|iPod/i;

/**
 * True for iPhone/iPad/iPod, and for iPadOS 13+ which reports a desktop
 * "Macintosh" UA with multi-touch. A real Mac reports maxTouchPoints 0.
 */
export function isIosDevice(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  maxTouchPoints: number = typeof navigator === 'undefined' ? 0 : (navigator.maxTouchPoints ?? 0),
): boolean {
  if (IOS_USER_AGENT.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

/** Running as an installed web app rather than in a browser tab. */
export function isStandaloneWebApp(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (iosStandalone) return true;
  try {
    return window.matchMedia?.('(display-mode: standalone)')?.matches === true;
  } catch {
    // Older WebKit throws on unsupported media queries instead of returning false.
    return false;
  }
}

/** Can THIS page use the push stack at all? (False in every iOS browser tab.) */
export function canPageUseWebPush(): boolean {
  if (typeof window === 'undefined') return false;
  return 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
}

/**
 * An iPhone/iPad user who cannot be offered push because the site is not on the
 * Home Screen yet. Show install instructions instead of a dead button.
 */
export function needsIosHomeScreenInstall(): boolean {
  return isIosDevice() && !isStandaloneWebApp() && !canPageUseWebPush();
}
