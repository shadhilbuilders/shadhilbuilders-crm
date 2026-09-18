'use client';

// usePushSubscription - web push (VAPID) subscription lifecycle.
//
// T-PUSH (2026-09-08): drives the CURRENT device's web-push subscription.
// Permission consent is a separate concern - this hook does NOT fire the
// browser prompt. It exposes:
//   - isSupported   whether the browser can do web push here (SW + PushManager +
//                    Notification + VAPID key configured). The app uses this to
//                    decide whether to SHOW an enable-push prompt.
//   - isSubscribed  whether this device already has an active subscription.
//   - enablePush()  user-initiated: request permission (if needed) + subscribe
//                    + POST to /api/push/subscribe. Returns true on success.
//   - checked       whether initial state (support + existing sub) resolved.
//
// Best-effort: any failure no-ops / returns false - the app still works, it
// just can't push. The dialog that drives this lives in PushEnablePrompt.
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/apis/client';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64WithPadding = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64WithPadding);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * A bounded substitute for `navigator.serviceWorker.ready`.
 *
 * WHY THIS EXISTS (root-caused live on the Settings page, 2026-09-18):
 * `navigator.serviceWorker.ready` NEVER SETTLES when no service worker is
 * registered - it stays pending forever; it does not reject. Registration is
 * deliberately skipped in development (`ServiceWorkerRegistrar`: "Skip
 * registration in dev"), so in dev this promise hung indefinitely, `setChecked(true)`
 * was never reached, and every consumer was stuck showing "Checking..." - the
 * enable-prompt could not fire and the Settings page's push state never resolved.
 *
 * The `try/catch` around the old call could not help: a promise that never
 * settles never throws.
 *
 * Behavior: if a registration/active worker already exists, resolve immediately
 * (ZERO added latency on the real production path). Otherwise wait briefly for
 * one to activate, then give up with `null` so callers report "unsupported"
 * instead of spinning forever.
 */
const SW_READY_TIMEOUT_MS = 3000;
const SW_POLL_MS = 100;

async function swReadyOrNull(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  // Fast path: an active worker is already there, so no waiting at all.
  if (navigator.serviceWorker.controller !== null) {
    return navigator.serviceWorker.ready;
  }
  const deadline = Date.now() + SW_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const regs = await navigator.serviceWorker.getRegistrations();
    const withActive = regs.find((r) => r.active !== null);
    if (withActive !== undefined) {
      // A worker is active, so `ready` resolves now - safe to await.
      return navigator.serviceWorker.ready;
    }
    await new Promise((resolve) => setTimeout(resolve, SW_POLL_MS));
  }
  return null;
}

export type PushCapability = {
  isSupported: boolean;
  isSubscribed: boolean;
  checked: boolean;
  /** Current `Notification.permission` ('default' | 'granted' | 'denied'). */
  permission: NotificationPermission;
  /** User-initiated: request permission (if needed) + subscribe + register. */
  enablePush: () => Promise<boolean>;
};

export function usePushSubscription(): PushCapability {
  const [isSupported, setIsSupported] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'default',
  );
  const subRef = useRef<PushSubscription | null>(null);

  // Track permission changes the user makes in the browser's site settings
  // (the address-bar / ⓘ dialog) so the prompt's guidance stays accurate even
  // after the user fixes the block without going through our dialog.
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    const update = (): void => setPermission(Notification.permission);
    update();
    // `permission`/`persmissionchange` on Notification is not standardized
    // across browsers; re-read on window focus instead (covers the common
    // "user toggles it in settings, then returns to the tab" flow).
    window.addEventListener('focus', update);
    return () => window.removeEventListener('focus', update);
  }, []);

  // On mount: detect browser capability + whether this device is already
  // subscribed. Never requests permission here.
  useEffect(() => {
    let cancelled = false;

    const run = async (): Promise<void> => {
      // Feature detect first - no SW / PushManager / Notification in this
      // browser means push is impossible; set checked and stop.
      const supported =
        typeof window !== 'undefined' &&
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window;
      if (!supported) {
        if (!cancelled) {
          setIsSupported(false);
          setChecked(true);
        }
        return;
      }

      try {
        const reg = await swReadyOrNull();
        if (cancelled) return;
        // No active service worker means push is impossible on this page -
        // resolve to unsupported NOW instead of waiting on a promise that can
        // never settle (see swReadyOrNull's comment).
        if (reg === null) {
          setIsSupported(false);
          setChecked(true);
          return;
        }
        // Push disabled server-side -> nothing to subscribe to.
        const { publicKey } = await api<{ publicKey: string | null }>('/push/vapid-key');
        if (cancelled) return;
        if (!publicKey) {
          setIsSupported(false);
          setChecked(true);
          return;
        }
        const existing = await reg.pushManager.getSubscription();
        if (cancelled) return;
        subRef.current = existing;
        setIsSupported(true);
        setIsSubscribed(existing !== null);
        setChecked(true);
      } catch {
        if (!cancelled) {
          setIsSupported(false);
          setChecked(true);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const enablePush = useCallback(async (): Promise<boolean> => {
    try {
      const reg = await swReadyOrNull();
      // A user-initiated enable with no service worker can never succeed:
      // return false so the caller surfaces the real reason instead of
      // leaving the button spinning on an unsettled promise.
      if (reg === null) return false;
      const { publicKey } = await api<{ publicKey: string | null }>('/push/vapid-key');
      if (!publicKey) return false;

      // A fresh (not yet subscribed) device needs permission first. If it's
      // already granted for this origin (returning user), skip the prompt.
      const existing = (await reg.pushManager.getSubscription()) ?? subRef.current;
      if (existing) {
        subRef.current = existing;
        setIsSubscribed(true);
        return true;
      }

      const permission = await Notification.requestPermission();
      setPermission(permission);
      if (permission !== 'granted') return false;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      });
      subRef.current = sub;
      setIsSubscribed(true);
      setPermission('granted');

      await api('/push/subscribe', {
        method: 'POST',
        json: {
          endpoint: sub.endpoint,
          p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')!))),
          auth: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth')!))),
          platform: 'WEB',
        },
      });
      return true;
    } catch {
      return false;
    }
  }, []);

  return { isSupported, isSubscribed, checked, permission, enablePush };
}
