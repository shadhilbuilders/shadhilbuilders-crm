'use client';

import { NextThemeProvider, Toaster } from '@paalstack/react-ui';
import { type ReactNode } from 'react';

import { QueryProvider } from './query-provider';

type ProvidersProps = {
  children: ReactNode;
};

/**
 * Client provider tree for the web app.
 *
 * Layer order (matters for state-context inheritance):
 *   1. NextThemeProvider — `next-themes` wrapper, SSR-safe, drives .dark on <html>.
 *   2. Toaster            — sonner-based toast renderer; reads theme from
 *                            NextThemeProvider via the ToastProviderWrapper
 *                            chain so toasts auto-re-skin on theme switch.
 *   3. QueryProvider      — react-query client.
 *   4. children           — the app routes.
 */
export const Providers = ({ children }: ProvidersProps) => {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <Toaster />
      <QueryProvider>{children}</QueryProvider>
    </NextThemeProvider>
  );
};