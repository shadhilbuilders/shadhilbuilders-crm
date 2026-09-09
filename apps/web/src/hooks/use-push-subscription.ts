'use client';

// usePushSubscription - web push (VAPID) subscription lifecycle.
//
// T-PUSH (2026-09-08): on mount, if the browser supports push + the service
// worker is active, fetch the VAPID public key from the backend and subscribe
// the current device. The subscription is POSTed to /api/push/subscribe so the
// backend can deliver web pushes to this user.
//
// Best-effort: any failure (no push support, no SW, no VAPID key, permission
// denied) silently no-ops - the app still works, it just can't push.
import { useEffect } from 'react';

import { api } from '@/apis/client';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64WithPadding = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64WithPadding);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export function usePushSubscription(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    if (!('PushManager' in window)) return;
    if (!('Notification' in window)) return;

    let cancelled = false;

    const run = async (): Promise<void> => {
      try {
        const reg = await navigator.serviceWorker.ready;
        if (cancelled) return;

        // Fetch the VAPID public key. Null = push disabled on the backend.
        const { publicKey } = await api<{ publicKey: string | null }>('/push/vapid-key');
        if (cancelled) return;
        if (!publicKey) return;

        const existing = await reg.pushManager.getSubscription();
        if (existing) return; // already subscribed

        const permission = await Notification.requestPermission();
        if (cancelled) return;
        if (permission !== 'granted') return;

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
        });

        await api('/push/subscribe', {
          method: 'POST',
          json: {
            endpoint: sub.endpoint,
            p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')!))),
            auth: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth')!))),
            platform: 'WEB',
          },
        });
      } catch {
        // best-effort - swallow
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);
}
