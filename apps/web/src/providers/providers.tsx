'use client';

import { NextThemeProvider } from '@paalstack/react-ui';
import { type ReactNode } from 'react';

import { QueryProvider } from './query-provider';

type ProvidersProps = {
  children: ReactNode;
};

/**
 * Client provider tree for the web app.
 *
 * Layer order (matters for state-context inheritance):
 *   1. NextThemeProvider - `next-themes` wrapper, SSR-safe, drives .dark
 *      on <html>. NOTE (2026-09-05): it ALSO mounts the sonner Toaster
 *      internally (ToastProviderWrapper → ToastProvider → <Toaster>
 *      richColors closeButton position="top-right", theme-aware via
 *      useNextTheme) - so an app-level <Toaster /> must NOT be added
 *      here. Mounting both renders every toast TWICE in different
 *      corners (verified in-browser: same toast at top/right AND
 *      bottom/right). Pass per-app toast config via the provider's
 *      `toastProps` prop if the library defaults ever need overriding.
 *   2. QueryProvider     - react-query client.
 *   3. children          - the app routes.
 */
export const Providers = ({ children }: ProvidersProps) => {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
    >
      <QueryProvider>{children}</QueryProvider>
    </NextThemeProvider>
  );
};