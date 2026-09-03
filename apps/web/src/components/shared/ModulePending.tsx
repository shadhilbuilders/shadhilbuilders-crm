'use client';

// Shared "module not built yet" surface.
//
// HONEST-STATE CONTRACT: the leads/visits/chat/bookings/notifications/audit
// backend modules are scaffolded (contracts in packages/api-types) but not
// implemented yet. Pages MUST show this state when their API call fails with
// a 404/501 — never fabricate data or hide the gap. When a module lands,
// its page switches to live data with zero UI changes.
//
// T18 (PR2): when `isLoading`, render a shape-matched Skeleton instead of
// the text "Loading {title}…". The Skeleton's cross-fade (T17) hides the
// swap so the user sees a smooth transition from shape to content.
//
// The state machine (CEO §1 P1) is unchanged:
//
//   ┌──────────────┐   query.isLoading === true
//   │   loading    │   → render <Skeleton variant="list" />  (was: text)
//   └──────┬───────┘
//          │ query resolves
//          ▼
//   ┌──────────────┐   query.error is 404/501
//   │ not built    │   → render <Empty "module pending">
//   │  (module)    │
//   └──────┬───────┘
//          │ module built, other error
//          ▼
//   ┌──────────────┐
//   │  api error   │   → render <Empty "failed to load">
//   └──────┬───────┘
//          │ query.data defined & non-empty
//          ▼
//   ┌──────────────┐
//   │  has data    │   → consumer renders real UI
//   └──────────────┘
import {
  Badge,
  Button,
  Empty,
  SkeletonContainer as LibSkeletonContainer,
} from '@paalstack/react-ui';
import Link from 'next/link';

import { ApiError } from '@/apis/client';

import { Skeleton } from './Skeleton';

export type ModulePendingProps = {
  /** Human module name, e.g. "Lead Inbox". */
  title: string;
  /** One line on what will live here. */
  description: string;
  /** The error from the API call, if any. */
  error: unknown;
  /** While the request is in flight. */
  isLoading?: boolean;
  /**
   * Skeleton variant to render while loading. Default `list` (the
   * most common surface — a vertical list of records). Pages that
   * need a different shape (e.g. `chart` for the dashboard) pass
   * an explicit `skeletonVariant`. The `text` variant uses the
   * library's `SkeletonContainer` (stacked shimmer lines) — best
   * for flat lists of pending records (notifications, audit). */
  skeletonVariant?: 'list' | 'table' | 'card' | 'chart' | 'kpi' | 'text';
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
  skeletonVariant = 'list',
}: ModulePendingProps) {
  if (isLoading) {
    // The "text" variant delegates to the library's SkeletonContainer
    // (stacked shimmer lines) since it is the common case — a flat
    // list of pending records (notifications, audit entries, etc.).
    // For structured surfaces (table, chart, card, list) we use our
    // own shape-matched Skeleton.
    if (skeletonVariant === 'text') {
      return (
        <div
          role="status"
          aria-busy="true"
          aria-live="polite"
          aria-label={`Loading ${title.toLowerCase()}`}
        >
          <LibSkeletonContainer
            count={5}
            className="h-4 w-full"
            isFullWidth
            wrapperClassName="space-y-3"
          />
        </div>
      );
    }
    return (
      <Skeleton
        variant={skeletonVariant}
        aria-label={`Loading ${title.toLowerCase()}`}
      />
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
