'use client';

// ChartTooltipWithSkeleton — recharts `content` prop that shows a
// Skeleton placeholder when no data is hovered, and the real
// ChartTooltipContent when active.
//
// T38 (PR3): bridges the gap between "chart-shape skeleton" and
// "live data" — when a user hovers over a chart surface during the
// brief window between SkeletonContainer cross-fade and the data
// being interactive, the tooltip itself shows a placeholder
// instead of "0" or empty rows.
//
// Recharts always renders the `content` component, but only paints
// it visibly when `active` is true. So the Skeleton variant stays
// in the DOM as a hidden "fallback surface" until the user hovers
// and active flips, at which point we show the real tooltip. This
// is the same trick the shadcn `chart-tooltip-default` example
// uses; we add the Skeleton placeholder so the surface is never
// "blank" for a hovering user.
import type { ReactNode } from 'react';

import { Skeleton } from './Skeleton';

export type ChartTooltipWithSkeletonProps = {
  /** Recharts provides `active` + `payload` + `label` to the content. */
  active?: boolean;
  /**
   * Recharts' payload is a `readonly` array; we accept `unknown[]` and
   * normalize internally. The recharts `TooltipPayload` type uses
   * `NameType | undefined` / `ValueType | undefined` which is wider
   * than `string | number`, so narrowing at the boundary is the
   * cleanest place to bridge.
   */
  payload?: ReadonlyArray<unknown>;
  label?: string | number;
  /** Map a dataKey to a friendly label. Falls back to the raw key. */
  formatLabel?: (dataKey: string) => string;
  /** Render the real tooltip body. */
  renderTooltip: (params: {
    active: boolean;
    label: string;
    items: Array<{ label: string; value: string; color?: string }>;
  }) => ReactNode;
};

/**
 * Coerce a recharts payload entry to the narrow shape our `renderTooltip`
 * expects. Recharts' public types are wider (NameType/ValueType can be
 * `number | string | (string | number)[]`), so we stringify + coerce
 * here once.
 */
function normalizePayload(
  payload: ReadonlyArray<unknown> | undefined,
): Array<{ label: string; value: string; color?: string }> {
  if (payload === undefined) return [];
  return payload.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return { label: '', value: '' };
    }
    const e = entry as {
      name?: unknown;
      value?: unknown;
      color?: unknown;
      dataKey?: unknown;
    };
    return {
      label:
        typeof e.dataKey === 'string'
          ? e.dataKey
          : typeof e.name === 'string' || typeof e.name === 'number'
            ? String(e.name)
            : '',
      value:
        e.value === undefined || e.value === null
          ? ''
          : Array.isArray(e.value)
            ? e.value.map(String).join(', ')
            : String(e.value),
      color: typeof e.color === 'string' ? e.color : undefined,
    };
  });
}

/**
 * Default content for recharts `<Tooltip content={...} />`. Renders a
 * Skeleton-shaped tooltip when the chart is not actively hovered,
 * and the caller's `renderTooltip` body when the user hovers over a
 * real data point.
 */
export function ChartTooltipWithSkeleton({
  active = false,
  payload = [],
  label = '',
  formatLabel,
  renderTooltip,
}: ChartTooltipWithSkeletonProps) {
  if (!active) {
    // Hidden when the user is not hovering — but keep the Skeleton in
    // the DOM so the surface is "shape-ready" the moment a hover
    // starts. T38 verify: a hovering user during isLoading sees
    // this shape, not a blank tooltip.
    return (
      <div
        aria-hidden="true"
        className="border-border bg-background min-w-[180px] rounded-md border p-3 opacity-0"
        data-qa="chart-tooltip-skeleton"
      >
        <Skeleton variant="card" count={2} />
      </div>
    );
  }

  const items = normalizePayload(payload);
  if (items.length > 0 && formatLabel !== undefined) {
    items.forEach((item) => {
      item.label = formatLabel(item.label) || item.label;
    });
  }

  return <>{renderTooltip({ active, label: String(label), items })}</>;
}
