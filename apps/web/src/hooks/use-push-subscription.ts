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
 * Does this browser subscription belong to the VAPID key the server currently
 * serves?
 *
 * Rotating the key pair leaves every existing browser subscription bound to the
 * OLD `applicationServerKey`. Sends against it fail at the push service with a
 * 403 (`VapidPkHashMismatch`), which is not a 404/410, so the backend never
 * prunes the row (`push.service.deliver`) - the device silently stops receiving
 * push while the UI still reports "subscribed". Comparing the keys is what makes
 * a rotation self-heal: the stale subscription is dropped and the device
 * re-subscribes against the current key.
 *
 * Unreadable option (Safari) counts as a match, so an unreadable value never
 * throws away a subscription that still works.
 */
function matchesServerKey(sub: PushSubscription, publicKey: string): boolean {
  const raw = sub.options?.applicationServerKey;
  if (!raw) return true;
  const existing = new Uint8Array(raw as ArrayBuffer);
  const current = urlBase64ToUint8Array(publicKey);
  if (existing.length !== current.length) return false;
  return existing.every((byte, i) => byte === current[i]);
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
  /**
   * The browser holds a subscription the SERVER cannot deliver to: no row, or a
   * row registered under a retired VAPID key. `isSubscribed` is false in that
   * state; this flag is what makes "Re-register this device" appear instead of a
   * dead end where the badge claims enabled and nothing ever arrives.
   */
  needsRepair: boolean;
  /** User-initiated: request permission (if needed) + subscribe + register. */
  enablePush: () => Promise<boolean>;
  /** User-initiated: drop whatever the browser holds and register against the current key. */
  reRegister: () => Promise<boolean>;
};

type PushServerStatus = { registered: boolean; keyMatches: boolean };

/** POST the browser's subscription so the server can actually deliver to it. */
async function registerWithServer(sub: PushSubscription): Promise<PushServerStatus> {
  return api<PushServerStatus>('/push/subscribe', {
    method: 'POST',
    json: {
      endpoint: sub.endpoint,
      p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')!))),
      auth: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth')!))),
      platform: 'WEB',
    },
  });
}

/** Server truth about this endpoint. The only authority on whether push can land. */
async function fetchServerStatus(endpoint: string): Promise<PushServerStatus> {
  return api<PushServerStatus>(`/push/status?endpoint=${encodeURIComponent(endpoint)}`);
}

export function usePushSubscription(): PushCapability {
  const [isSupported, setIsSupported] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [needsRepair, setNeedsRepair] = useState(false);
  const [checked, setChecked] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'default',
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
        setIsSupported(true);

        if (existing === null) {
          subRef.current = null;
          setIsSubscribed(false);
          setNeedsRepair(false);
          setChecked(true);
          return;
        }

        // The browser holding a subscription proves nothing about the server:
        // the row may have been pruned on 404/410, dropped after a VAPID key
        // rotation, or never written because the subscribe POST failed. That gap
        // is how a device shows "Enabled on this device" while receiving
        // nothing. Ask the server, then reconcile.
        let status: PushServerStatus | null = null;
        try {
          status = await fetchServerStatus(existing.endpoint);
        } catch {
          // Backend unreachable. Fall back to trusting the browser rather than
          // telling a working device it is broken.
          status = null;
        }
        if (cancelled) return;

        if (status === null || (status.registered && status.keyMatches)) {
          subRef.current = existing;
          setIsSubscribed(true);
          setNeedsRepair(false);
          setChecked(true);
          return;
        }

        if (status.registered && !status.keyMatches) {
          // Registered under a retired VAPID key: nothing can make this endpoint
          // deliver, and leaving it in place also makes subscribe() throw
          // InvalidStateError. Drop it and offer the repair path.
          await existing.unsubscribe().catch(() => undefined);
          if (cancelled) return;
          subRef.current = null;
          setIsSubscribed(false);
          setNeedsRepair(true);
          setChecked(true);
          return;
        }

        // Not registered at all. If the browser's key is the one the server
        // signs with now, the row was simply pruned or the POST never landed -
        // re-post it (idempotent, no user gesture needed). A browser key that
        // does not match means the device has to subscribe again, which needs a
        // click on iOS.
        const keyMatches = matchesServerKey(existing, publicKey);
        const healed = keyMatches
          ? await registerWithServer(existing).then(
              (result) => result.keyMatches,
              () => false,
            )
          : false;
        if (cancelled) return;
        if (!keyMatches) await existing.unsubscribe().catch(() => undefined);
        subRef.current = healed ? existing : null;
        setIsSubscribed(healed);
        setNeedsRepair(!healed);
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
      if (existing !== null && matchesServerKey(existing, publicKey)) {
        // Already subscribed here, but never claim success before the SERVER has
        // the row: a failed POST is exactly how a device ends up showing
        // "enabled" while nothing can be delivered.
        const registered = await registerWithServer(existing).then(
          (result) => result.keyMatches,
          () => false,
        );
        subRef.current = registered ? existing : null;
        setIsSubscribed(registered);
        setNeedsRepair(!registered);
        return registered;
      }
      if (existing !== null) {
        // Bound to a retired VAPID key - clear it before subscribing again.
        // Leaving it in place makes `subscribe()` throw InvalidStateError.
        await existing.unsubscribe().catch(() => undefined);
        subRef.current = null;
        setIsSubscribed(false);
      }

      const permission = await Notification.requestPermission();
      setPermission(permission);
      if (permission !== 'granted') return false;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      });

      // Register with the server FIRST, then claim the state. `setIsSubscribed`
      // before this point is what made a failed POST look like success.
      const result = await registerWithServer(sub).then(
        (value) => value,
        () => null,
      );
      if (result === null) {
        subRef.current = null;
        setIsSubscribed(false);
        setNeedsRepair(true);
        return false;
      }
      subRef.current = sub;
      setIsSubscribed(true);
      setNeedsRepair(!result.keyMatches);
      setPermission('granted');
      return true;
    } catch {
      return false;
    }
  }, []);

  /**
   * Repair path for a device whose browser subscription the server cannot use
   * (row pruned, never written, or registered under a retired VAPID key).
   *
   * Always re-subscribes rather than reusing: `subscribe()` on a live
   * subscription returns the SAME endpoint, so reusing it after a rotation can
   * never produce a deliverable one. Runs from a click, which is the user
   * activation iOS requires for subscribe().
   */
  const reRegister = useCallback(async (): Promise<boolean> => {
    try {
      const reg = await swReadyOrNull();
      if (reg === null) return false;
      const { publicKey } = await api<{ publicKey: string | null }>('/push/vapid-key');
      if (!publicKey) return false;

      const existing = await reg.pushManager.getSubscription();
      if (existing !== null) await existing.unsubscribe().catch(() => undefined);
      subRef.current = null;

      const permission =
        Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      setPermission(permission);
      if (permission !== 'granted') return false;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      });
      const result = await registerWithServer(sub).then(
        (value) => value,
        () => null,
      );
      if (result === null) {
        setIsSubscribed(false);
        setNeedsRepair(true);
        return false;
      }
      subRef.current = sub;
      setIsSubscribed(true);
      setNeedsRepair(false);
      return true;
    } catch {
      return false;
    }
  }, []);

  return { isSupported, isSubscribed, checked, permission, needsRepair, enablePush, reRegister };
}
