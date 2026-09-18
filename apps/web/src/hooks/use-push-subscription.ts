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
        const reg = await navigator.serviceWorker.ready;
        if (cancelled) return;
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
      const reg = await navigator.serviceWorker.ready;
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
