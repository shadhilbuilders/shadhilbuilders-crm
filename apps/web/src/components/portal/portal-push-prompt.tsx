'use client';

// PortalPushPrompt (issue #8 slice 2, AC9).
//
// WHY THIS EXISTS: the portal is the ONLY surface a CUSTOMER ever sees. The
// staff shell's PushEnablePrompt (components/push-enable-prompt.tsx) is mounted
// in AuthenticatedShell, and AuthenticatedShell bounces every CUSTOMER to
// /portal before rendering (see authenticated-shell.tsx). Settings ->
// Notifications is behind /[orgSlug], which the portal guard bounces too. So
// before this component existed there was no path at all by which a buyer could
// create a PushSubscription row, which made PortalNotifier's recipient query
// always resolve to zero, which made AC9 and the slice-2 E2E gate unreachable
// no matter how green the suite was.
//
// Deliberately NOT the AlertDialog the staff shell uses. The design's customer
// home is a calm, single-purpose timeline; a modal on first paint fights that
// (and the design forbids dashboard chrome on this page). This is an inline,
// dismissible card above the timeline that asks once, in the buyer's language,
// and gets out of the way.
//
// Dismissal is durable (localStorage) for the same reason the staff prompt's is:
// a declined buyer must not be asked again on every visit. Unlike the staff
// prompt there is no Settings fallback for a CUSTOMER, so the card also leaves
// a re-entry point: tapping any photo still works, and clearing the latch is
// one browser-data action. The copy keeps the promise narrow (new photos only).
//
// Permission is requested from a click (a user gesture), which is the platform
// requirement for Notification.requestPermission.
import { useEffect, useState } from 'react';

import { Button, toast } from '@paalstack/react-ui';
import { LuBell, LuX } from '@paalstack/react-icons/lu';

import { usePushSubscription } from '@/hooks/use-push-subscription';

const DISMISS_KEY = 'shadhil:portal-push-dismissed';
/** Bump to deliberately re-offer to buyers who previously declined. */
const PROMPT_VERSION = 'v1';

function safeGetItem(key: string): string | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, value);
  } catch {
    // ignore - dismissal just won't persist in restrictive contexts
  }
}

export function PortalPushPrompt() {
  const push = usePushSubscription();
  const [dismissed, setDismissed] = useState(true); // optimistic: hidden until checked
  const [pending, setPending] = useState(false);
  const [blocked, setBlocked] = useState(false);

  // Read the latch on mount (never during render: localStorage is client-only
  // and SSR would hydrate a mismatch).
  useEffect(() => {
    setDismissed(safeGetItem(DISMISS_KEY) === PROMPT_VERSION);
  }, []);

  // If the buyer fixes a block in the browser's site settings and returns, the
  // hook re-reads Notification.permission on focus; finish the flow for them.
  useEffect(() => {
    if (!blocked || push.permission !== 'granted') return;
    const run = async (): Promise<void> => {
      if (await push.enablePush()) {
        setBlocked(false);
        safeSetItem(DISMISS_KEY, PROMPT_VERSION);
        setDismissed(true);
        toast.success('Notifications enabled');
      }
    };
    void run();
  }, [blocked, push.permission, push.enablePush]);

  const handleEnable = async (): Promise<void> => {
    setPending(true);
    const ok = await push.enablePush();
    setPending(false);
    if (ok) {
      safeSetItem(DISMISS_KEY, PROMPT_VERSION);
      setDismissed(true);
      toast.success('Notifications enabled');
      return;
    }
    if (push.permission === 'denied') {
      // Permanently blocked for this origin - requestPermission can never
      // prompt again, so guide instead of leaving a dead button.
      setBlocked(true);
    }
  };

  const handleDismiss = (): void => {
    safeSetItem(DISMISS_KEY, PROMPT_VERSION);
    setDismissed(true);
  };

  // Hidden while: the latch is set, capability has not resolved, the browser
  // cannot push here, or this device is already subscribed. A buyer who cannot
  // receive push is never shown a promise the app cannot keep.
  if (dismissed || !push.checked || !push.isSupported || push.isSubscribed) return null;

  return (
    <div
      data-qa="portal-push-prompt"
      className="border-border bg-muted-soft relative rounded-lg border p-4"
    >
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss notification prompt"
        data-qa="portal-push-dismiss"
        className="text-muted-foreground absolute right-2 top-2 flex size-11 items-center justify-center"
      >
        <LuX className="size-4" aria-hidden="true" />
      </button>
      <div className="flex items-start gap-3 pr-8">
        <LuBell className="text-foreground mt-0.5 size-5 flex-none" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-foreground text-base font-medium" data-qa="portal-push-title">
            Get a notification when new photos arrive
          </p>
          <p className="text-muted-foreground text-sm">
            {blocked
              ? 'Notifications are blocked for this site. Open your browser\u2019s site settings, allow notifications, then try again.'
              : 'We will send one when the site team posts progress on your home.'}
          </p>
        </div>
      </div>
      <Button
        type="button"
        size="lg"
        className="mt-3 min-h-11 w-full"
        onClick={() => void handleEnable()}
        disabled={pending}
        data-qa="portal-push-enable"
      >
        {pending ? 'Enabling...' : blocked ? 'Try again' : 'Enable notifications'}
      </Button>
    </div>
  );
}
