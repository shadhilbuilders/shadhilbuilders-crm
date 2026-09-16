'use client';

// Shared error surface for route-level Next.js error boundaries and pages
// that render a caught error inline. Renders @paalstack/react-ui's
// ErrorInternalServer with a retry — never a blank screen or infinite
// skeleton.
import { useEffect } from 'react';

import { ErrorInternalServer } from '@paalstack/react-ui';

export function PageError({
  error,
  onRefresh,
  onGoBack = () => window.history.back(),
  logToConsole = true,
}: {
  error: Error;
  onRefresh: () => void;
  onGoBack?: () => void;
  logToConsole?: boolean;
}) {
  useEffect(() => {
    if (logToConsole) console.error(error);
  }, [error, logToConsole]);

  return (
    <div className="flex min-h-[calc(100dvh-64px)] w-full items-center justify-center">
      <ErrorInternalServer
        error={error}
        showErrorMessage
        goBackText="Go back"
        refreshText="Try again"
        onRefresh={onRefresh}
        onGoBack={onGoBack}
      />
    </div>
  );
}
