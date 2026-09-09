'use client';

// ChartCard - thin glue around `ModulePending` for chart surfaces.
//
// Eng-review Section 1 [P1]: "ChartCard must be glue around ModulePending,
// not an independent state machine." This component owns ONLY the wiring
// from a TanStack Query result (isLoading / error / data) into the
// ModulePending contract. The chart's visual layer (recharts primitives,
// the `Chart` wrapper, ARIA labels, etc.) is the caller's job - passed
// in via `children(data)` once data exists.
//
// T22 (PR3) will wrap this in an ErrorBoundary that renders an `Empty`
// fallback if a chart's render path throws. Until then, a thrown render
// bubbles to the nearest error boundary (Next.js's default for /app).
//
// State machine (kept here, not in ModulePending, so a single diagram
// is colocated with the wiring):
//
//   ┌──────────────┐   query.isLoading === true
//   │   loading    │   → render <ModulePending isLoading />
//   └──────┬───────┘
//          │ query resolves
//          ▼
//   ┌──────────────┐   query.error is 404/501
//   │ not built    │   → render <ModulePending error={...} />  (the
//   │  (module)    │     honest-state contract from ModulePending)
//   └──────┬───────┘
//          │ module built, other error
//          ▼
//   ┌──────────────┐
//   │  api error   │   → render <ModulePending error={...} />  (Empty)
//   └──────┬───────┘
//          │ query.data defined & non-empty
//          ▼
//   ┌──────────────┐
//   │  has data    │   → render children(data)
//   └──────┬───────┘
//          │ query.data is empty array/object
//          ▼
//   ┌──────────────┐
//   │  empty       │   → render <Empty title="No data" /> via ModulePending
//   └──────────────┘
//
// T19 (PR2) replaces the ModulePending "Loading title…" text with the
// shape-matched Skeleton variant. This file is unchanged by T19 - it
// already passes `isLoading` to ModulePending, and ModulePending is the
// single point that knows how to render a "module loading" state.

import { Card, CardContent, CardHeader, CardTitle, Empty, ErrorBoundary } from '@paalstack/react-ui';

import { ModulePending } from '@/components/shared/ModulePending';
import { SkeletonContainer } from '@/components/shared/SkeletonContainer';
import type { ChartDataHint } from '@/components/shared/Skeleton';

export type ChartCardProps<T> = {
  /** Human title shown in the card header and in the pending fallback. */
  title: string;
  /** One-line description used by the pending fallback. */
  description: string;
  /** TanStack Query result (or a structurally compatible one). */
  query: {
    isLoading: boolean;
    error: unknown;
    data: T | undefined;
  };
  /**
   * Renders the actual chart when data is defined and non-empty. Called
   * only with values that pass `isEmptyData(data) === false`. The caller
   * is responsible for accessibility (aria-label, color contrast) - this
   * glue layer doesn't second-guess chart-specific markup.
   */
  children: (data: T) => React.ReactNode;
  /**
   * Optional override for the empty-state copy. Default: "No data yet".
   * When data is empty, the card body still renders inside `CardContent`
   * so the chart's axis/labels reserve their space - important for
   * layout stability on first paint.
   */
  emptyTitle?: string;
  /**
   * T19 / T34: shape hint for the chart skeleton so the placeholder
   * matches the real chart's geometry. Defaults to `'bar'` (the most
   * common case - PipelineFunnelChart and VisitsThisWeekChart both
   * use bar layouts). Pass `'pie'` for LeadStatusPie, `'line'` for
   * AuditTimeline, etc.
   */
  dataHint?: ChartDataHint;
};

/**
 * Predicate for "data is empty". A consumer that wants to treat a
 * single-value payload as "non-empty" can pass a custom `isEmpty` later;
 * the default covers the two common shapes: `[]` and `{}`.
 */
function isEmptyData(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === 'object') return Object.keys(data).length === 0;
  return false;
}

export function ChartCard<T>({
  title,
  description,
  query,
  children,
  emptyTitle = 'No data yet',
  dataHint = 'bar',
}: ChartCardProps<T>) {
  // T22 + T31: the entire ChartCard body is wrapped in an ErrorBoundary
  // so a render throw inside a chart (e.g. malformed data) shows an
  // <Empty> fallback instead of a white screen or infinite skeleton.
  // The skeleton is *not* a valid fallback here - a skeleton hides the
  // failure, which makes the bug unobservable. The user needs to see
  // the error so they can report it (CEO §2 1B + re-review 1D).
  return (
    <ErrorBoundary FallbackComponent={ChartCardErrorFallback}>
      <ChartCardBody
        title={title}
        description={description}
        query={query}
        emptyTitle={emptyTitle}
        dataHint={dataHint}
      >
        {children}
      </ChartCardBody>
    </ErrorBoundary>
  );
}

// ---------------------------------------------------------------------------
// Internal: actual state-machine, separated so the ErrorBoundary can
// catch render throws without re-entering the boundary.
// ---------------------------------------------------------------------------

function ChartCardBody<T>({
  title,
  description,
  query,
  children,
  emptyTitle = 'No data yet',
  dataHint = 'bar',
}: ChartCardProps<T>) {
  // 1. Loading - render a shape-matched chart skeleton (T19) inside the
  //    cross-fade SkeletonContainer (T17) so the transition to real data
  //    is a 200ms fade rather than a pop.
  if (query.isLoading) {
    return (
      <ChartFrame title={title}>
        <SkeletonContainer
          isLoading
          skeleton={{ variant: 'chart', dataHint }}
        >
          {/* Children render only after isLoading flips, so this is
              a placeholder. The SkeletonContainer keeps the chart
              frame stable so the layout doesn't shift on hydration. */}
          <div aria-hidden="true" />
        </SkeletonContainer>
      </ChartFrame>
    );
  }

  // 2. Error - including 404/501 (handled inside ModulePending). The
  //    shape matches the existing chart surface so users see the same
  //    "backend module pending" empty that other pages use.
  if (query.error !== null && query.error !== undefined) {
    return (
      <ChartFrame title={title}>
        <ModulePending
          title={title}
          description={description}
          error={query.error}
        />
      </ChartFrame>
    );
  }

  // 3. Resolved but empty - same frame, but the body shows "No data yet"
  //    instead of the "module pending" copy (because the module IS
  //    built, it just returned nothing). Rendered directly with <Empty>
  //    - NOT via ModulePending, which would fall through to the
  //    "backend module pending" branch when error is null.
  if (query.data === undefined || isEmptyData(query.data)) {
    return (
      <ChartFrame title={title}>
        <Empty
          title={emptyTitle}
          description={`${title} has no records to plot yet.`}
        />
      </ChartFrame>
    );
  }

  // 4. Has data - render the chart inside the frame. SkeletonContainer
  //    keeps the cross-fade in place: when isLoading was true and now
  //    is false, the skeleton layer fades out and the children fade in.
  return (
    <ChartFrame title={title}>
      <SkeletonContainer isLoading={false}>
        {children(query.data)}
      </SkeletonContainer>
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// T22 + T31: ErrorBoundary fallback. Renders an <Empty> with the
// error message so the failure is visible to the user. We deliberately
// do NOT render a Skeleton (skeleton hides the failure) and we do NOT
// log to console here - the ErrorBoundary logs by default.
// ---------------------------------------------------------------------------

function ChartCardErrorFallback({
  error,
  resetErrorBoundary,
}: {
  error: unknown;
  resetErrorBoundary: () => void;
}) {
  const message = error instanceof Error ? error.message : 'Chart failed to render.';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Chart unavailable</CardTitle>
      </CardHeader>
      <CardContent>
        <Empty
          title="This chart failed to load"
          description={message}
        >
          <button
            type="button"
            onClick={resetErrorBoundary}
            className="text-primary text-sm underline underline-offset-4"
          >
            Try again
          </button>
        </Empty>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Internal: shared card chrome so every state lines up visually.
// ---------------------------------------------------------------------------

function ChartFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
