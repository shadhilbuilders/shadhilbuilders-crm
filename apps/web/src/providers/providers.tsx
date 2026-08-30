'use client';

import { ThemeProvider } from '@paalstack/react-ui';
import { type ReactNode } from 'react';

import { QueryProvider } from './query-provider';

type ProvidersProps = {
  children: ReactNode;
};

export const Providers = ({ children }: ProvidersProps) => {
  return (
    <ThemeProvider>
      <QueryProvider>{children}</QueryProvider>
    </ThemeProvider>
  );
};
