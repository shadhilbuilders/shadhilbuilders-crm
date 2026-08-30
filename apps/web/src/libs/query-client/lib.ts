/**
 * TanStack React Query Configuration
 *
 * Configures the QueryClient with sensible defaults for:
 * - Retry logic
 * - Cache times
 * - Stale times
 * - Error handling
 * - Refetch behavior
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Don't retry failed requests by default
      retry: false,

      // Retry delay increases exponentially (1s, 2s, 4s, ...)
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),

      // Data is considered fresh for 5 minutes
      staleTime: 5 * 60 * 1000,

      // Cache data for 5 minutes after queries become inactive
      gcTime: 5 * 60 * 1000,

      // Refetch on window focus only in production
      refetchOnWindowFocus: process.env.NODE_ENV === 'production',

      // Refetch when network reconnects
      refetchOnReconnect: true,

      // Refetch on mount even if data is fresh
      refetchOnMount: true,
    },
    mutations: {
      // Don't retry mutations by default (override per mutation if needed)
      retry: 0,
    },
  },
});

/**
 * Create a separate query client for testing.
 * Configures no retries and an infinite cache to prevent test flakiness.
 */
export const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
      },
    },
  });
