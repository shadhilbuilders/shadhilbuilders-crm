'use client';

// Shared error surface for route-level Next.js error boundaries and pages
// that render a caught error inline. Renders @paalstack/react-ui's
// ErrorInternalServer with a retry - never a blank screen or infinite
// skeleton.
import { useEffect } from 'react';

import { ErrorInternalServer } from '@paalstack/react-ui';

export function PageError({
  error,
  onRefresh,
  onGoBack,
  logToConsole = true,
  showErrorMessage = true,
}: {
  error: Error;
  onRefresh: () => void;
  /**
   * Optional, and ABSENT by default. `window.history.back()` is wrong for a
   * screen with no previous view of its own - a buyer deep-linked here from a
   * push notification has no portal history to go back to, so the button did
   * nothing visible. Callers that do have a home to return to pass an explicit
   * destination.
   */
  onGoBack?: () => void;
  logToConsole?: boolean;
  /**
   * Whether to print the raw `error.message`. On for staff surfaces (an admin
   * can act on "relation does not exist"), OFF for customer-facing ones: a
   * buyer reading "boom" or a Prisma string learns nothing and it can leak
   * internals.
   */
  showErrorMessage?: boolean;
}) {
  useEffect(() => {
    if (logToConsole) console.error(error);
  }, [error, logToConsole]);

  return (
    // The library's controls are h-8 (32px), under the 44px minimum this app
    // holds on touch. The selector below raises them without forking the
    // component or fighting its own class list.
    <div className="flex min-h-[calc(100dvh-64px)] w-full items-center justify-center [&_button]:min-h-11">
      <ErrorInternalServer
        error={error}
        showErrorMessage={showErrorMessage}
        goBackText="Go back"
        refreshText="Try again"
        onRefresh={onRefresh}
        onGoBack={onGoBack}
      />
    </div>
  );
}
