'use client';

// PortalSignOut: the buyer's only exit from the portal.
//
// WHY IT EXISTS: a CUSTOMER is bounced out of every staff surface
// (AuthenticatedShell, redirectForArea), and the portal's bottom bar holds a
// single Refresh action - so before this control there was NO way to end a
// session from the product. On a shared family phone that is the difference
// between "sign in as me" and "you are me now" until the cookie expires.
//
// It matters most on /portal/change-password, where the buyer holds a
// temporary password the office read out to somebody else and may not even
// want to replace on this device. That screen deliberately has no Cancel (see
// the page), so this is its escape hatch.
//
// CONFIRM, unlike the staff shell (owner call, 2026-11-10). A staff user hits
// Sign out from a menu they had to open on purpose; this is a bare icon in a
// masthead, one thumb-width from the theme toggle. An accidental tap costs a
// buyer a trip back through a password they may not have - so it asks.
//
// NO BUTTON SIZE OVERRIDES (owner direction, 2026-11-10). The control itself
// uses the library's defaults rather than hand-picked dimensions:
//   - IconButton renders `buttonVariants({ size: "icon", rounded: "md" })`,
//     i.e. a 32px (size-8) square with the md radius. That is the library's
//     answer to "icon button", and it is what every other icon button in the
//     product already looks like.
//   - The AlertDialog's own buttons keep their default height; the dialog
//     footer already stacks them full-width below sm.
// Do not reintroduce size/min-h/rounded classes on the BUTTON - if it is too
// small to tap, that is a library-level decision, not a portal one.
//
// THE ICON IS SIZED SEPARATELY. The library's button base carries
// `[&_svg:not([class*='size-'])]:size-4`, so an svg with any `size-*` class
// opts OUT of that fallback and takes the given size. The glyph is set to
// size-5 (20px) inside the 32px box: the library's 16px default reads thin at
// this weight on a light masthead, and 20px is the optical match for the
// 24px stroke icon used at the size the row actually renders.
import { useState } from 'react';

import { AlertDialog, IconButton, toast } from '@paalstack/react-ui';
import { LuLogOut } from '@paalstack/react-icons/lu';

import { useSignOut } from '@/lib/auth-actions';

/** Glyph size only - the button keeps the library's size-8 box. */
const ICON_SIZE = 'size-5';

export function PortalSignOut() {
  const signOut = useSignOut();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  const handleConfirm = async (): Promise<void> => {
    // Re-entry guard: a double tap on confirm must not fire two sign-outs (the
    // second would run against an already-cleared cookie and surface a
    // misleading error toast for an action that actually succeeded).
    if (pending) return;
    setPending(true);
    try {
      // Hard navigation to /login inside the hook - deliberate, so the client
      // router cannot restore this portal from its cache (see auth-actions.ts).
      await signOut();
      // No state reset on success: the document is being replaced.
    } catch {
      setPending(false);
      setConfirming(false);
      toast.error('Could not sign out. Please try again.');
    }
  };

  return (
    <>
      {/* The trigger is a SIBLING of the dialog, not a child: AlertDialog's
          `children` render inside the portaled popup, so nesting the button
          here would put it in the dialog rather than the masthead. `trigger` is
          null and `open` is controlled - same pattern as
          components/inventory/ProgressPhotoActions.tsx. */}
      <IconButton
        type="button"
        variant="ghost"
        className='size-9 min-h-9 min-w-9 rounded-full p-0 sm:size-11 sm:min-h-11 sm:min-w-11'
        icon={<LuLogOut className={ICON_SIZE} aria-hidden="true" />}
        // The icon is the only content: without this the control has NO
        // accessible name (axe `button-name`, critical).
        aria-label="Sign out"
        data-qa="portal-sign-out"
        onClick={() => setConfirming(true)}
      />
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          // Block dismissing mid-flight: the session is already being
          // destroyed, so closing the dialog while the request is in flight
          // would look like a no-op that then navigates anyway.
          if (pending) return;
          setConfirming(open);
        }}
        trigger={null}
        header={{
          title: 'Sign out of your portal?',
          description: "You'll need your email and password to sign back in.",
        }}
        cancelButtonText="Cancel"
        confirmButtonText={pending ? 'Signing out...' : 'Sign out'}
        cancelButtonProps={{ disabled: pending }}
        confirmButtonProps={{ disabled: pending }}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void handleConfirm()}
      >
        <p className="text-muted-foreground text-sm">
          Signing out ends this session on this device.
        </p>
      </AlertDialog>
    </>
  );
}
