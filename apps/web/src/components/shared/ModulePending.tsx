'use client';

// Shared "module not built yet" surface.
//
// HONEST-STATE CONTRACT: the leads/visits/chat/bookings/notifications/audit
// backend modules are scaffolded (contracts in packages/api-types) but not
// implemented yet. Pages MUST show this state when their API call fails with
// a 404/501 — never fabricate data or hide the gap. When a module lands,
// its page switches to live data with zero UI changes.
import { Badge, Button, Empty } from '@paalstack/react-ui';
import Link from 'next/link';

import { ApiError } from '@/apis/client';

export type ModulePendingProps = {
  /** Human module name, e.g. "Lead Inbox". */
  title: string;
  /** One line on what will live here. */
  description: string;
  /** The error from the API call, if any. */
  error: unknown;
  /** While the request is in flight. */
  isLoading?: boolean;
};

function isNotImplemented(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 501)
  );
}

export function ModulePending({
  title,
  description,
  error,
  isLoading = false,
}: ModulePendingProps) {
  if (isLoading) {
    return (
      <div className="text-muted-foreground py-24 text-center text-sm">
        Loading {title.toLowerCase()}…
      </div>
    );
  }

  // Request went through and the endpoint exists — a different failure.
  if (error !== null && error !== undefined && !isNotImplemented(error)) {
    return (
      <Empty
        title={`${title} failed to load`}
        description={
          error instanceof Error ? error.message : 'Unexpected API error.'
        }
      />
    );
  }

  // Endpoint absent (404 from NestJS router) → module genuinely not built.
  return (
    <Empty
      title={`${title} — backend module pending`}
      description={description}
    >
      <div className="mt-2 flex items-center justify-center gap-2">
        <Badge variant="secondary">Not built yet</Badge>
        <span className="text-muted-foreground text-xs">
          UI is wired to the locked API contract and lights up when the module
          ships (Implementation Plan Weeks 4–7).
        </span>
      </div>
    </Empty>
  );
}

/** Standard "back" affordance for sub-pages. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-1 px-2 text-sm"
    >
      ← {label}
    </Link>
  );
}

export { Button };