// T25 (PR3) - useOnlineStatus: SSR-safe online/offline tracker.
//
// Returns `true` when the browser is online (default for SSR and the
// initial paint to avoid a flash of "Will sync when online" before
// the navigator API is read). Subscribes to the browser's
// `online`/`offline` events so the value stays fresh.
//
// Used by the offline-aware skeleton wiring on the notifications
// and audit pages (T25 verify).
'use client';

import { useEffect, useState } from 'react';

export function useOnlineStatus(): boolean {
  // Default true so SSR and the first paint don't flash the offline
  // state before navigator.onLine is read.
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    setOnline(navigator.onLine);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return online;
}
