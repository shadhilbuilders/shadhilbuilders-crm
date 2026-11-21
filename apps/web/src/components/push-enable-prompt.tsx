'use client';

// PushEnablePrompt - ask the user to enable web push, via an AlertDialog.
//
// Dismissal is DURABLE (localStorage), not session-scoped. It previously used
// sessionStorage, which meant a field user who declined once was asked again on
// every fresh browser session - read by the user as "the prompt keeps showing
// up", the same complaint as the PWA install prompt. A durable latch is safe
// here because declining is NOT a dead end: Settings -> Notifications carries a
// permanent "Enable" button for this device (apps/web/src/app/[orgSlug]/settings/page.tsx),
// so anyone who changes their mind has a visible path back.
//
// Bump PROMPT_VERSION to re-offer deliberately (e.g. when a new alert type
// ships and the value of enabling goes up); the stored value is compared against
// it so an older dismissal does not suppress the new offer.
//
// Drives the same usePushSubscription hook as the shell; permission is a
// user gesture (the browser prompt fires only after they click "Enable"),
// satisfying the platform requirement that requestPermission be inside a
// user-activation event.
import { useEffect, useRef, useState } from 'react';

import { AlertDialog, toast } from '@paalstack/react-ui';

import { usePushSubscription } from '@/hooks/use-push-subscription';
import {
  IOS_INSTALL_HINT_KEY,
  IOS_INSTALL_HINT_VERSION,
  IOS_PUSH_MIN_VERSION,
  needsIosHomeScreenInstall,
} from '@/lib/push-install-guidance';
import { LuInfo } from '@paalstack/react-icons/lu';

const DISMISS_KEY = 'shadhil:push-prompt-dismissed';
/** Bump to deliberately re-offer push to users who previously declined. */
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

export function PushEnablePrompt() {
  const push = usePushSubscription();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  // True once the user has denied/enabled-failed: the browser cannot re-prompt
  // a denied permission, so we keep the dialog open and guide them to the
  // browser's site-settings instead of dismissing with a toast.
  const [blocked, setBlocked] = useState(false);
  // True when this is not an "enable it" dialog but an "install it first" one:
  // iOS/iPadOS hide the whole Push API outside a Home Screen web app, so there
  // is nothing to enable in a Safari tab.
  const [installHint, setInstallHint] = useState(false);
  // Once an enable SUCCEEDED there is nothing left to offer in this mount. The
  // open-gate re-runs when `open` flips back to false, and `isSubscribed` does
  // not flip synchronously, so without this the dialog would immediately reopen
  // over the success toast.
  const doneRef = useRef(false);

  // Show the dialog once push capability resolves. Two ways in:
  //   1. push is available here, not enabled yet, not dismissed -> offer it;
  //   2. this is an iPhone/iPad browser tab, where push cannot exist at all ->
  //      show the Add to Home Screen instructions. Without this branch the
  //      prompt rendered nothing on iOS, and silence reads as "broken".
  // Fired in an effect (not during render) to avoid a state-update-during-render
  // warning, and only after the initial capability check resolves.
  useEffect(() => {
    if (!push.checked || open || doneRef.current) return;
    if (push.isSupported) {
      if (!push.isSubscribed && safeGetItem(DISMISS_KEY) !== PROMPT_VERSION) {
        setInstallHint(false);
        setOpen(true);
      }
      return;
    }
    if (
      needsIosHomeScreenInstall() &&
      safeGetItem(IOS_INSTALL_HINT_KEY) !== IOS_INSTALL_HINT_VERSION
    ) {
      setInstallHint(true);
      setOpen(true);
    }
  }, [push.checked, push.isSupported, push.isSubscribed, open]);

  // If the user was guided to fix the block and returns to the tab with the
  // permission now granted (the hook re-reads Notification.permission on
  // window focus), complete the flow automatically - no second click needed.
  useEffect(() => {
    if (!blocked || push.permission !== 'granted') return;
    const run = async (): Promise<void> => {
      const ok = await push.enablePush();
      if (ok) {
        doneRef.current = true;
        setBlocked(false);
        setOpen(false);
        toast.success('Push notifications enabled');
      }
    };
    void run();
  }, [blocked, push.permission, push.enablePush]);

  const handleDismiss = (): void => {
    setBlocked(false);
    if (installHint) {
      // Separate latch from the push offer: a user who says "not now" to the
      // install hint must still be offered push normally once they are inside
      // the installed app, and vice versa.
      safeSetItem(IOS_INSTALL_HINT_KEY, IOS_INSTALL_HINT_VERSION);
    } else {
      // Must write the SAME value the open-gate compares against
      // (PROMPT_VERSION), not a bare '1': a mismatch here makes the dialog
      // re-open on every mount, which is strictly worse than the session-scoped
      // behaviour this replaced.
      safeSetItem(DISMISS_KEY, PROMPT_VERSION);
    }
    setOpen(false);
  };

  const handleEnable = async (): Promise<void> => {
    // The install hint has no permission request to make - "Got it" just closes.
    if (installHint) {
      handleDismiss();
      return;
    }
    setPending(true);
    const ok = await push.enablePush();
    setPending(false);
    if (ok) {
      doneRef.current = true;
      setBlocked(false);
      setOpen(false);
      toast.success('Push notifications enabled');
    } else if (push.permission === 'denied') {
      // Permission is permanently blocked for this site - `requestPermission`
      // will never show a prompt again. Keep the dialog open and walk the user
      // through the browser's site settings instead of a dead-end toast.
      setBlocked(true);
    }
    // 'default' (the user closed the browser prompt without choosing) and
    // transient API failures just leave the dialog open for another try.
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setBlocked(false);
        if (next) setOpen(true);
        else handleDismiss();
      }}
      trigger={null}
      header={{
        title: installHint
          ? 'Add Shadhil CRM to your Home Screen'
          : blocked
            ? 'Notifications are blocked'
            : 'Enable notifications?',
        description: installHint ? (
          <span>
            iPhone and iPad only deliver notifications to apps on the Home Screen. In Safari, tap
            the Share button, choose &quot;Add to Home Screen&quot;, then open the new icon and
            enable notifications there. Requires iOS {IOS_PUSH_MIN_VERSION} or later.
          </span>
        ) : blocked ? (
          <span>
            This browser has blocked notifications for Shadhil CRM, so a prompt can no longer be
            shown. To enable them: click the lock/padlock icon (or{' '}
            <LuInfo className="inline-block size-3" />) next to the address bar URL, open "Site
            settings", set Notifications to "Allow", then click below.'
          </span>
        ) : (
          'Get alerts for new leads, handoffs, and reminders right in this browser, even when Shadhil CRM is in another tab.'
        ),
      }}
      cancelButtonText="Not now"
      confirmButtonText={
        installHint
          ? 'Got it'
          : pending
            ? 'Enabling...'
            : blocked
              ? "I've enabled it"
              : 'Enable notifications'
      }
      confirmButtonProps={{ disabled: pending, autoFocus: false }}
      cancelButtonProps={{ autoFocus: false, tabIndex: -1 }}
      onConfirm={() => void handleEnable()}
      onCancel={handleDismiss}
    />
  );
}
