'use client';

import { useEffect, useState } from 'react';
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
// '/?source=pwa-v2') to force the prompt to re-show — users who
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
    // access. Silent fail — treat as "not dismissed" and let the toast
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
 * Listens for `beforeinstallprompt` (Chromium only — iOS Safari does
 * NOT fire this event, see comment in install-prompt UI). When the
 * event fires, shows a sonner toast with [Install] / [Not now] buttons.
 *
 * Dismissal is persisted in localStorage; the toast re-shows only
 * when the manifest's `id` version changes (per design review D4).
 */
export const InstallPrompt = () => {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const dismissed = safeGetItem(DISMISS_KEY);
    const currentVersion = getCurrentDataVersion();
    if (dismissed === currentVersion) return;

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      // D4: bottom-attached toast. `duration: Infinity` so it stays
      // until the user explicitly chooses Install or Not now.
      toast(
        <div className="motion-reduce:transition-none flex w-full items-center gap-3">
          <LuDownload className="h-5 w-5 shrink-0" aria-hidden="true" />
          <p className="flex-1 text-sm">Install Shadhil CRM for offline use</p>
          <Button
            size="sm"
            onClick={async () => {
              if (deferred) {
                await deferred.prompt();
                setDeferred(null);
              }
            }}
          >
            Install
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              safeSetItem(DISMISS_KEY, currentVersion);
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
  }, [deferred]);

  return null;
};
