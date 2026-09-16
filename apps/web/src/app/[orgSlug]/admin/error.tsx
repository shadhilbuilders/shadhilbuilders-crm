'use client';

// Error boundary for the admin namespace. See PageError for details.
import { PageError } from '@/components/shared/PageError';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError error={error} onRefresh={reset} />;
}
