'use client';

// Skeleton - single generic loading-placeholder component with variants.
//
// T16 (PR2) + T34 (PR3). DRY collapse per CEO §5 1D: ONE component,
// multiple shape variants, instead of 4 dedicated files. Wraps the
// library's `Skeleton` primitive (which already applies brand pulse
// + `bg-muted`) with our own variant API so pages don't hand-roll
// `h-4 w-32 bg-muted animate-pulse` snippets. The brand color, pulse
// animation, and motion-reduce handling are inherited from the
// library - this file only owns the *shape* contract.
//
// Variants and the exact shapes they render (T32 - shape-count tests
// pin these counts so a future "I tweaked the skeleton" change fails
// the build if it breaks the shape contract):
//
//   ┌────────┬───────────────────────────────────────────────────┐
//   │ kpi    │ 4 cells: label (h-3 w-20) + value (h-8 w-24)      │
//   │ chart  │ 1 frame: h-40 w-full. dataHint adds inside-shape  │
//   │        │   (bar=5 bars, pie=1 circle, line=zigzag,         │
//   │        │    area=3 humps). The frame is bg-muted; the      │
//   │        │   inside-shape is geometry, not a Skeleton.       │
//   │ table  │ 5 rows × 4 columns of h-10 cells                  │
//   │ list   │ 6 items: avatar + 2 text lines per item           │
//   │ card   │ 1 cell: h-32 w-full rounded-lg                    │
//   │ user   │ 1 row: avatar + 2 text lines (sidebar/topbar)     │
//   │ navItems │ N rows: icon (h-4 w-4) + label (h-4 w-24), 5 default │
//   │ projectSwitcher │ 1 row: icon + 2 text lines + chevron   │
//   │ text   │ N lines: h-4 w-full, 3 lines by default            │
//   └────────┴───────────────────────────────────────────────────┘
//
// Honors `prefers-reduced-motion`: the library's `Skeleton` already
// pairs `animate-pulse` with `motion-reduce:animate-none`. T26
// asserts the absence of `motion-reduce:animate-none` would fail.
import {
  Skeleton as LibSkeleton,
  SkeletonContainer as LibSkeletonContainer,
} from '@paalstack/react-ui';
import type { ReactNode } from 'react';

export type SkeletonVariant =
  | 'kpi'
  | 'chart'
  | 'table'
  | 'list'
  | 'card'
  | 'user'
  | 'users'
  | 'navItems'
  | 'projectSwitcher'
  | 'overview'
  | 'text';

/** T34: when `variant="chart"`, this prop selects the inside-shape
 *  so the skeleton matches the real chart's geometry on first paint. */
export type ChartDataHint = 'bar' | 'pie' | 'line' | 'area';

export type SkeletonProps = {
  variant: SkeletonVariant;
  /** Override the default count for the variant (kpi, table, list, text). */
  count?: number;
  /** Chart inside-shape - only consulted when `variant="chart"`. */
  dataHint?: ChartDataHint;
  /**
   * T25 (PR3): when true, the skeleton renders an offline hint
   * ("Will sync when online") alongside the shape. The hook that
   * renders the skeleton (e.g. a page) decides this based on
   * `navigator.onLine`; this component just adds the label.
   * Only meaningful for `variant="list"` - the other variants
   * are too small for a meaningful inline message.
   */
  isOffline?: boolean;
  /** Extra classes appended to the wrapper. */
  className?: string;
};

// ---------------------------------------------------------------------------
// Per-variant shape definitions (T32 - these are the contract).
//
// Pure data, exported for the test that asserts the shape-count pin.
// Keeping them in one place means a variant tweak touches a single
// object literal, not a tree of conditional renderers.
// ---------------------------------------------------------------------------

export const SKELETON_SHAPES = {
  kpi: { count: 4, cells: { label: 'h-3 w-20', value: 'h-8 w-24' } },
  chart: { count: 1, frame: 'h-40 w-full rounded-md' },
  table: { count: 5, row: 'h-10', cols: 4 },
  list: { count: 6, item: { avatar: 'h-9 w-9', lines: 2 } },
  card: { count: 1, shape: 'h-32 w-full rounded-lg' },
  user: { count: 1, avatar: 'h-10 w-10', lines: 2 },
  // Sidebar nav-group placeholder rows (icon + label), shown while the
  // session/role is still resolving so the sidebar isn't an empty gap
  // alongside a full-page PageLoading. 5 rows is a typical work-group size.
  navItems: { count: 5, icon: 'h-4 w-4', label: 'h-4 w-24' },
  users: {
    count: 1,
    header: { title: 'h-6 w-24', subtitle: 'h-4 w-56' },
    toolbar: { search: 'h-9 w-64', filter: 'h-9 w-40', create: 'h-9 w-32' },
    rows: 5,
    cols: 4,
  },
  projectSwitcher: {
    count: 1,
    icon: 'h-8 w-8',
    lines: 2,
    chevron: 'h-4 w-4',
  },
  // Overview KPI cards: 4 card-shaped placeholders - each with a description
  // label, a large value, a badge action, and a footer line. (Originally sized
  // to mirror the now-deleted OverviewSectionCards; the shape is still what
  // this variant is for, so it stays.)
  overview: {
    count: 4,
    card: 'rounded-xl ring-1 ring-foreground/10',
    label: 'h-3 w-20',
    value: 'h-8 w-24',
    badge: 'h-5 w-16',
    footer: 'h-3 w-3/4',
  },
  text: { count: 3, shape: 'h-4 w-full' },
} as const;

/** Pure helper for the test that asserts the chart inside-shape. */
export function getChartShape(hint: ChartDataHint | undefined): ReactNode {
  switch (hint) {
    case 'pie':
      // 1 circle - the canonical pie placeholder. T32 pins this count.
      return (
        <div
          aria-hidden="true"
          className="bg-muted-foreground/20 h-32 w-32 rounded-full"
          data-qa="skeleton-pie"
        />
      );
    case 'line':
      return (
        <svg
          aria-hidden="true"
          viewBox="0 0 100 40"
          className="text-muted-foreground/30 h-24 w-full"
        >
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            points="0,30 15,15 30,25 45,10 60,20 75,8 90,18 100,12"
          />
        </svg>
      );
    case 'area':
      return (
        <svg
          aria-hidden="true"
          viewBox="0 0 100 40"
          className="text-muted-foreground/30 h-24 w-full"
        >
          <path
            d="M0,30 C20,10 40,40 60,15 C80,5 90,25 100,20 L100,40 L0,40 Z"
            fill="currentColor"
            opacity="0.4"
          />
        </svg>
      );
    case 'bar':
    case undefined:
    default:
      // 5 bars - the canonical bar-chart shape. T32 pins this count.
      return (
        <div
          className="flex h-32 items-end justify-around gap-2 px-2"
          data-qa="skeleton-bar"
        >
          {[60, 80, 45, 90, 70].map((height, index) => (
            <div
              key={index}
              aria-hidden="true"
              className="bg-muted-foreground/20 w-8 rounded-t"
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
      );
  }
}

/**
 * Render the Skeleton. The output is a `<div role="status"
 * aria-busy="true" aria-live="polite">` so screen readers announce
 * "loading" - T26 asserts the `aria-busy` is present. `aria-label`
 * gives a short hint to assistive tech.
 */
export function Skeleton({
  variant,
  count,
  dataHint,
  isOffline = false,
  className,
}: SkeletonProps) {
  const c = count ?? SKELETON_SHAPES[variant].count;
  const label = `Loading ${variant}`;

  const content = (() => {
    switch (variant) {
      case 'kpi':
        return (
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            {Array.from({ length: c }).map((_, index) => (
              <div key={index} className="space-y-2">
                <LibSkeleton
                  className={SKELETON_SHAPES.kpi.cells.label}
                />
                <LibSkeleton
                  className={SKELETON_SHAPES.kpi.cells.value}
                />
              </div>
            ))}
          </div>
        );

      case 'chart':
        // The chart frame is NOT a LibSkeleton (the inside-shape is
        // geometry, not a shimmer box). The frame is a plain muted div
        // that wraps the inside-shape.
        return (
          <div
            className={`bg-muted ${SKELETON_SHAPES.chart.frame} flex items-center justify-center`}
            data-qa="skeleton-chart-frame"
          >
            {getChartShape(dataHint)}
          </div>
        );

      case 'table':
        return (
          <div
            className="border-border overflow-x-auto rounded-lg border"
            data-qa="skeleton-table"
          >
            <div className="space-y-0">
              {Array.from({ length: c }).map((_, index) => (
                <div
                  key={index}
                  className="border-border flex gap-4 border-b px-4 py-3 last:border-b-0"
                >
                  {Array.from({ length: SKELETON_SHAPES.table.cols }).map(
                    (_, colIndex) => (
                      <LibSkeleton
                        key={colIndex}
                        className={`${SKELETON_SHAPES.table.row} flex-1`}
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        );

      case 'list':
        return (
          <div className="space-y-3" data-qa="skeleton-list">
            {isOffline ? (
              <p
                className="text-muted-foreground text-xs"
                data-qa="skeleton-offline-hint"
              >
                Will sync when online
              </p>
            ) : null}
            <ul className="space-y-3">
              {Array.from({ length: c }).map((_, index) => (
                <li key={index} className="flex items-center gap-3">
                  <LibSkeleton
                    className={`${SKELETON_SHAPES.list.item.avatar} rounded-full`}
                  />
                  <div className="flex-1 space-y-2">
                    <LibSkeleton className="h-3 w-3/4" />
                    <LibSkeleton className="h-3 w-1/2" />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );

      case 'card':
        return (
          <LibSkeleton className={SKELETON_SHAPES.card.shape} />
        );

      case 'user':
        return (
          <div
            className="flex items-center gap-3"
            data-qa="skeleton-user"
          >
            <LibSkeleton
              className={`${SKELETON_SHAPES.user.avatar} rounded-full`}
            />
            <div className="flex-1 space-y-2">
              <LibSkeleton className="h-3 w-32" />
              <LibSkeleton className="h-3 w-20" />
            </div>
          </div>
        );

      case 'navItems':
        return (
          <ul className="space-y-1" data-qa="skeleton-nav-items">
            {Array.from({ length: c }).map((_, index) => (
              <li key={index} className="flex items-center gap-2 rounded-md p-2">
                <LibSkeleton
                  className={`${SKELETON_SHAPES.navItems.icon} shrink-0 rounded-sm`}
                />
                <LibSkeleton className={SKELETON_SHAPES.navItems.label} />
              </li>
            ))}
          </ul>
        );

      case 'users':
        // Dedicated users-page skeleton (autoplan 2026-09-09): mirrors the
        // real page layout - PageHeader (title + subtitle), then a DataTable
        // with a toolbar (search + role filter + create button) and a table
        // body of rows. Replaces the generic `variant="user"` avatar row
        // that was a poor fit for a full page.
        return (
          <div className="space-y-6" data-qa="skeleton-users">
            {/* PageHeader */}
            <div className="space-y-2">
              <LibSkeleton className={SKELETON_SHAPES.users.header.title} />
              <LibSkeleton className={SKELETON_SHAPES.users.header.subtitle} />
            </div>
            {/* DataTable: toolbar */}
            <div className="flex flex-wrap items-center gap-2">
              <LibSkeleton className={SKELETON_SHAPES.users.toolbar.search} />
              <LibSkeleton className={SKELETON_SHAPES.users.toolbar.filter} />
              <LibSkeleton
                className={`${SKELETON_SHAPES.users.toolbar.create} ml-auto`}
              />
            </div>
            {/* DataTable: body */}
            <div
              className="border-border overflow-x-auto rounded-lg border"
              data-qa="skeleton-users-table"
            >
              {Array.from({ length: SKELETON_SHAPES.users.rows }).map(
                (_, index) => (
                  <div
                    key={index}
                    className="border-border flex gap-4 border-b px-4 py-3 last:border-b-0"
                  >
                    {Array.from({ length: SKELETON_SHAPES.users.cols }).map(
                      (_, colIndex) => (
                        <LibSkeleton
                          key={colIndex}
                          className="h-10 flex-1"
                        />
                      ),
                    )}
                  </div>
                ),
              )}
            </div>
          </div>
        );

      case 'projectSwitcher':
        return (
          <div
            className="flex items-center gap-2"
            data-qa="skeleton-project-switcher"
          >
            <LibSkeleton
              className={`${SKELETON_SHAPES.projectSwitcher.icon} shrink-0 rounded-lg`}
            />
            <div className="grid flex-1 gap-1.5">
              <LibSkeleton className="h-3 w-32" />
              <LibSkeleton className="h-2 w-24" />
            </div>
            <LibSkeleton
              className={`${SKELETON_SHAPES.projectSwitcher.chevron} ml-auto shrink-0`}
            />
          </div>
        );

      case 'overview':
        // 4 card-shaped placeholders - description label, large value, badge
        // action, and a footer line - so the skeleton is a faithful shape-match
        // for a KPI card grid, not a generic grid. (Sized to mirror the deleted
        // OverviewSectionCards; nine live pages still mount this variant, so the
        // shape is what matters, not its original source.)
        return (
          <div
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
            data-qa="skeleton-overview"
          >
            {Array.from({ length: SKELETON_SHAPES.overview.count }).map(
              (_, index) => (
                <div
                  key={index}
                  className={`bg-card flex flex-col gap-4 p-4 ${SKELETON_SHAPES.overview.card}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-2">
                      <LibSkeleton
                        className={SKELETON_SHAPES.overview.label}
                      />
                      <LibSkeleton
                        className={SKELETON_SHAPES.overview.value}
                      />
                    </div>
                    <LibSkeleton
                      className={`${SKELETON_SHAPES.overview.badge} rounded-full`}
                    />
                  </div>
                  <div className="mt-auto space-y-2">
                    <LibSkeleton className={SKELETON_SHAPES.overview.footer} />
                    <LibSkeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ),
            )}
          </div>
        );

      case 'text':
        // Stacked shimmer lines - exactly what the library's
        // SkeletonContainer is designed for. We pass `className`
        // for each line's shape and `isFullWidth` so the lines
        // span the container, and `wrapperClassName` for the
        // gap between lines.
        return (
          <LibSkeletonContainer
            count={c}
            className={SKELETON_SHAPES.text.shape}
            isFullWidth
            wrapperClassName="space-y-2"
          />
        );
    }
  })();

  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label={label}
      className={className ?? ''}
      data-skeleton-variant={variant}
    >
      {content}
    </div>
  );
}
