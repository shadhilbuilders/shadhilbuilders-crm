'use client';

// Error boundary for the org namespace. See PageError for details.
import { PageError } from '@/components/shared/PageError';

export default function OrgError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError error={error} onRefresh={reset} />;
}
