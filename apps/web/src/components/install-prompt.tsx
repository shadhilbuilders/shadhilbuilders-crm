'use client';

import { useEffect } from 'react';
import { Button, toast } from '@paalstack/react-ui';
import { LuDownload, LuX } from '@paalstack/react-icons/lu';

// `BeforeInstallPromptEvent` is a non-standard browser API; declare the
// minimal shape we use so the component type-checks without requiring
// @types/web-app-polyfill or similar.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

const DISMISS_KEY = 'shadhil:install-prompt-dismissed';
// Bump this when the manifest's `id` changes (e.g. '/?source=pwa' →
// '/?source=pwa-v2') to force the prompt to re-show - users who
// declined the first time get a second chance when offline features land.
const DATA_VERSION = 'pwa-v1';

// Pull from the actual manifest to keep in sync. Falls back to the
// literal above.
const getCurrentDataVersion = (): string => {
  if (typeof document === 'undefined') return DATA_VERSION;
  const link = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
  const url = link?.href ?? '';
  const match = url.match(/pwa(-v\d+)?/);
  return match?.[0] ?? DATA_VERSION;
};

const safeGetItem = (key: string): string | null => {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(key);
  } catch {
    // Safari private mode + some embedded webviews throw on localStorage
    // access. Silent fail - treat as "not dismissed" and let the toast
    // show; the user just won't have the dismiss state persisted.
    return null;
  }
};

const safeSetItem = (key: string, value: string): void => {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, value);
  } catch {
    // Same as above.
  }
};

/**
 * Bottom-attached install-prompt toast (D4).
 *
 * Listens for `beforeinstallprompt` (Chromium only - iOS Safari does
 * NOT fire this event, see comment in install-prompt UI). When the
 * event fires, shows a sonner toast with [Install] / [Not now] buttons.
 *
 * Dismissal is persisted in localStorage; the toast re-shows only
 * when the manifest's `id` version changes (per design review D4).
 *
 * Implementation note (2026-09-02): the previous version stored the
 * deferred `BeforeInstallPromptEvent` in React state and read it from
 * the Install button's onClick closure. That was a stale-closure bug:
 * sonner renders toast content imperatively and does NOT re-render it
 * when the parent component re-renders, so the Install button kept
 * seeing `deferred = null` from the closure captured at toast-creation
 * time and silently no-op'd on every click. The fix captures the event
 * directly in the `onPrompt` closure (a local `const`), so each toast
 * has its own live reference to the event that triggered it.
 */
export const InstallPrompt = () => {
  useEffect(() => {
    const dismissed = safeGetItem(DISMISS_KEY);
    const currentVersion = getCurrentDataVersion();
    if (dismissed === currentVersion) return;

    const onPrompt = (e: Event) => {
      e.preventDefault();
      // Capture the event in this closure. The Install button's onClick
      // will close over `evt`, not over React state, so it stays valid
      // for the lifetime of the toast (sonner keeps the toast DOM node
      // alive across parent re-renders, so a `useState` capture would
      // be stale by the time the user clicks).
      const evt = e as BeforeInstallPromptEvent;

      const toastId = toast(
        <div className="motion-reduce:transition-none flex w-full items-center gap-3">
          <LuDownload className="h-5 w-5 shrink-0" aria-hidden="true" />
          <p className="flex-1 text-sm">Install Shadhil CRM for offline use</p>
          <Button
            size="sm"
            onClick={async () => {
              // BeforeInstallPromptEvent.prompt() is one-shot per event
              // (Chromium spec); after it resolves the user has either
              // accepted or dismissed. Calling it twice throws.
              try {
                await evt.prompt();
              } catch (err) {
                // Surface the failure so it shows up in console when the
                // user reports "install button doesn't work" - without
                // this, a thrown prompt() is invisible.
                console.error('[InstallPrompt] prompt() threw:', err);
              }
            }}
          >
            Install
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              // Persist the dismissal first so re-firing of
              // `beforeinstallprompt` (browsers re-emit on navigation)
              // does not resurrect the toast, then close the live
              // sonner toast via its id. Without toast.dismiss(toastId)
              // the toast sits on screen until reload - the user can see
              // the X click "do nothing" even though localStorage is set.
              safeSetItem(DISMISS_KEY, currentVersion);
              toast.dismiss(toastId);
            }}
            aria-label="Dismiss"
          >
            <LuX className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>,
        {
          duration: Infinity,
          position: 'bottom-center',
          className: 'motion-reduce:transition-none',
        },
      );
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  return null;
};
