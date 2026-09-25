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

/** Session latch: "we have already offered the install affordance". */
const SHOWN_KEY = 'shadhil:install-prompt-shown';
/** Durable latch: the app IS installed - never offer again. */
const INSTALLED_KEY = 'shadhil:install-prompt-installed';
/**
 * Bump when the install experience changes in a way that deserves a second
 * offer (e.g. offline support lands). The version is stored alongside the
 * session latch so an older dismissal does not suppress the new offer.
 */
const PROMPT_VERSION = 'pwa-v1';
/**
 * Stable sonner id. Repeat events UPDATE this toast instead of appending a
 * new one, which is the second line of defence behind the session latch.
 */
const TOAST_ID = 'shadhil-install-prompt';

/** `navigator.standalone` is iOS-only and untyped in lib.dom. */
const isIosStandalone = (): boolean => {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
};

/** Already installed AND currently running as an installed app. */
const isStandalone = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (isIosStandalone()) return true;
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches === true;
  } catch {
    return false;
  }
};

const safeGet = (storage: 'session' | 'local', key: string): string | null => {
  try {
    if (typeof window === 'undefined') return null;
    return (storage === 'session' ? window.sessionStorage : window.localStorage).getItem(key);
  } catch {
    // Safari private mode + some embedded webviews throw on storage access.
    // Silent fail - treat as "not dismissed" so the toast still shows; the
    // user just won't have the dismiss state persisted.
    return null;
  }
};

const safeSet = (storage: 'session' | 'local', key: string, value: string): void => {
  try {
    if (typeof window === 'undefined') return;
    (storage === 'session' ? window.sessionStorage : window.localStorage).setItem(key, value);
  } catch {
    // Same as above.
  }
};

/**
 * Bottom-attached install-prompt toast (D4).
 *
 * Listens for `beforeinstallprompt` (Chromium only - iOS Safari does NOT fire
 * this event) and shows one sonner toast with [Install] / [Dismiss].
 *
 * WHY THE SESSION LATCH IS NOT OPTIONAL (bug fixed 2026-09-24): Chromium
 * re-emits `beforeinstallprompt` on EVERY qualifying page load - and again
 * whenever the install mini-infobar is dismissed - not once per browser
 * session. The previous handler created a fresh, `duration: Infinity` toast
 * for each event, so every navigation appended another identical install
 * banner and they stacked on screen until reload. Three events produced three
 * prompts.
 *
 * The fix is threefold:
 *   1. A sessionStorage latch (`SHOWN_KEY`) written when the toast is created,
 *      so repeat events - including across client-side navigations - are
 *      ignored. Session-scoped (not permanent) so the affordance returns on a
 *      fresh browser session instead of being hidden forever.
 *   2. A stable sonner `id`, so any event that does slip through replaces the
 *      existing toast rather than appending a duplicate.
 *   3. `preventDefault()` still fires on EVERY event (before the latch check)
 *      to keep Chromium's mini-infobar suppressed even once we stop offering
 *      our own toast.
 *
 * Installed state is tracked durably (`INSTALLED_KEY`, localStorage) from both
 * the `appinstalled` event and an accepted `userChoice`, and standalone display
 * -mode / iOS `navigator.standalone` short-circuit the prompt entirely.
 *
 * Implementation note (2026-09-02): an earlier version stored the deferred
 * `BeforeInstallPromptEvent` in React state and read it from the Install
 * button's onClick closure. That was a stale-closure bug: sonner renders toast
 * content imperatively and does NOT re-render it when the parent re-renders, so
 * the Install button kept seeing `deferred = null` and silently no-op'd. The
 * fix captures the event in this closure (a local `const`), so each toast has
 * its own live reference to the event that triggered it.
 */
export const InstallPrompt = () => {
  useEffect(() => {
    if (isStandalone() || safeGet('local', INSTALLED_KEY) === '1') return;

    const onPrompt = (e: Event) => {
      // Suppress Chromium's own mini-infobar on every event, even when we
      // decide not to show our toast - otherwise the browser UI and our toast
      // both appear, which reads as "the prompt showed twice".
      e.preventDefault();

      if (safeGet('local', INSTALLED_KEY) === '1') return;
      // Latch: one offer per session (per PROMPT_VERSION).
      if (safeGet('session', SHOWN_KEY) === PROMPT_VERSION) return;
      safeSet('session', SHOWN_KEY, PROMPT_VERSION);

      // Capture the event in this closure. The Install button's onClick will
      // close over `evt`, not over React state, so it stays valid for the
      // lifetime of the toast (sonner keeps the toast DOM node alive across
      // parent re-renders, so a `useState` capture would be stale by the time
      // the user clicks).
      const evt = e as BeforeInstallPromptEvent;
      // `prompt()` is one-shot per event (Chromium spec): after it resolves
      // the user has accepted or dismissed, and calling it again throws.
      let consumed = false;

      const toastId = toast(
        <div className="flex w-full items-center gap-3 motion-reduce:transition-none">
          <LuDownload className="h-5 w-5 shrink-0" aria-hidden="true" />
          <p className="flex-1 text-sm">Install Shadhil CRM for offline use</p>
          <Button
            size="sm"
            onClick={async () => {
              if (consumed) return;
              consumed = true;
              try {
                await evt.prompt();
                const { outcome } = await evt.userChoice;
                if (outcome === 'accepted') {
                  // Durable: the app is (being) installed, so never offer again
                  // - even if `appinstalled` never fires.
                  safeSet('local', INSTALLED_KEY, '1');
                  toast.dismiss(toastId);
                }
              } catch (err) {
                // Surface the failure so it shows up in console when the user
                // reports "install button doesn't work" - without this, a
                // thrown prompt() is invisible.
                console.error('[InstallPrompt] prompt() threw:', err);
                // Let the user retry with a fresh event rather than leaving a
                // dead button on screen.
                consumed = false;
              }
            }}
          >
            Install
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              // The session latch is already written (above), so a re-emitted
              // event cannot resurrect the toast; just close the live sonner
              // toast via its id. Without toast.dismiss(toastId) the toast sits
              // on screen until reload - the user sees the X click "do nothing".
              toast.dismiss(toastId);
            }}
            aria-label="Dismiss"
          >
            <LuX className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>,
        {
          id: TOAST_ID,
          duration: Infinity,
          position: 'bottom-center',
          className: 'motion-reduce:transition-none',
          closeButton: false,
        }
      );
    };

    const onInstalled = () => {
      safeSet('local', INSTALLED_KEY, '1');
      toast.dismiss(TOAST_ID);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  return null;
};
