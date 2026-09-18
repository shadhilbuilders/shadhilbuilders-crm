'use client';

// PushEnablePrompt - ask the user to enable web push, via an AlertDialog.
//
// Mirrors install-prompt.tsx's localStorage-dismiss pattern: show the dialog
// once unless the user has already dismissed it or already enabled push.
// Drives the same usePushSubscription hook as the shell; permission is a
// user gesture (the browser prompt fires only after they click "Enable"),
// satisfying the platform requirement that requestPermission be inside a
// user-activation event.
import { useEffect, useState } from 'react';

import { AlertDialog, toast } from '@paalstack/react-ui';

import { usePushSubscription } from '@/hooks/use-push-subscription';

const DISMISS_KEY = 'shadhil:push-prompt-dismissed';

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

  const handleEnable = async (): Promise<void> => {
    setPending(true);
    const ok = await push.enablePush();
    setPending(false);
    if (ok) {
      toast.success('Push notifications enabled');
      setOpen(false);
    } else {
      toast.error('Push notifications are disabled in your browser; enable them in site settings.');
      // Don't re-nag every navigation - treat a denied permission as dismissed.
      safeSetItem(DISMISS_KEY, '1');
      setOpen(false);
    }
  };

  const handleDismiss = (): void => {
    safeSetItem(DISMISS_KEY, '1');
    setOpen(false);
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else handleDismiss();
      }}
      trigger={null}
      header={{
        title: 'Enable notifications?',
        description:
          'Get alerts for new leads, handoffs, and reminders right in this browser, even when Shadhil CRM is in another tab.',
      }}
      cancelButtonText="Not now"
      confirmButtonText={pending ? 'Enabling...' : 'Enable notifications'}
      confirmButtonProps={{ disabled: pending }}
      onConfirm={() => void handleEnable()}
      onCancel={handleDismiss}
    />
  );
}
