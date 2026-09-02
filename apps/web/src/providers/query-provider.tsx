'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';

import {
  queryClient,
  attachQueryPersister,
  rehydrateQueryCache,
} from '@/lib/query-client';

type QueryProviderProps = {
  children: ReactNode;
};

export const QueryProvider = ({ children }: QueryProviderProps) => {
  useEffect(() => {
    // Hydrate the cached server-state from IDB on first mount, then
    // attach the event-driven persister so future state changes are
    // saved. Both are no-ops on a fresh install (no cached state).
    let unsubscribe: (() => void) | null = null;
    void rehydrateQueryCache(queryClient).then(() => {
      unsubscribe = attachQueryPersister(queryClient);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
};
