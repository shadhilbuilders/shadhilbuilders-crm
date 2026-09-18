'use client';

// PushEnablePrompt - ask the user to enable web push, via an AlertDialog.
//
// Mirrors install-prompt.tsx's dismiss pattern (but in sessionStorage):
// show the dialog once per browser session unless the user has already
// dismissed it this session or already enabled push. Session-scoped so
// the prompt returns on a fresh browser session rather than being
// permanently hidden.
// Drives the same usePushSubscription hook as the shell; permission is a
// user gesture (the browser prompt fires only after they click "Enable"),
// satisfying the platform requirement that requestPermission be inside a
// user-activation event.
import { useEffect, useState } from 'react';

import { AlertDialog, toast } from '@paalstack/react-ui';

import { usePushSubscription } from '@/hooks/use-push-subscription';
import { LuInfo } from '@paalstack/react-icons/lu';

const DISMISS_KEY = 'shadhil:push-prompt-dismissed';

function safeGetItem(key: string): string | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem(key, value);
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

  // Show the dialog once push capability resolves: the browser supports push,
  // it's not yet enabled, and the user hasn't dismissed this before. Fired in
  // an effect (not during render) to avoid a state-update-during-render
  // warning, and only after the initial capability check resolves.
  useEffect(() => {
    if (
      push.checked &&
      push.isSupported &&
      !push.isSubscribed &&
      safeGetItem(DISMISS_KEY) !== '1' &&
      !open
    ) {
      setOpen(true);
    }
  }, [push.checked, push.isSupported, push.isSubscribed]);

  // If the user was guided to fix the block and returns to the tab with the
  // permission now granted (the hook re-reads Notification.permission on
  // window focus), complete the flow automatically - no second click needed.
  useEffect(() => {
    if (!blocked || push.permission !== 'granted') return;
    const run = async (): Promise<void> => {
      const ok = await push.enablePush();
      if (ok) {
        setBlocked(false);
        setOpen(false);
        toast.success('Push notifications enabled');
      }
    };
    void run();
  }, [blocked, push.permission, push.enablePush]);

  const handleEnable = async (): Promise<void> => {
    setPending(true);
    const ok = await push.enablePush();
    setPending(false);
    if (ok) {
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

  const handleDismiss = (): void => {
    setBlocked(false);
    safeSetItem(DISMISS_KEY, '1');
    setOpen(false);
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
        title: blocked
          ? 'Notifications are blocked'
          : 'Enable notifications?',
        description: blocked
          ? <span>This browser has blocked notifications for Shadhil CRM, so a prompt can no longer be shown. To enable them: click the lock/padlock icon (or <LuInfo className="size-2 inline-block" />) next to the address bar URL, open "Site settings", set Notifications to "Allow", then click below.'</span>
          : 'Get alerts for new leads, handoffs, and reminders right in this browser, even when Shadhil CRM is in another tab.',
      }}
      cancelButtonText="Not now"
      confirmButtonText={
        pending ? 'Enabling...' : blocked ? "I've enabled it" : 'Enable notifications'
      }
      confirmButtonProps={{ disabled: pending, autoFocus: true }}
      onConfirm={() => void handleEnable()}
      onCancel={handleDismiss}
    />
  );
}
