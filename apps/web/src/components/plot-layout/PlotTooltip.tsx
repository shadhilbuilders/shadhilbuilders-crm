// Hover / selection callout for the plot map.
//
// Rendered as HTML over the <svg>, not as SVG text inside it: SVG text scales
// with the viewBox, so the old pill was unreadably small zoomed out and
// huge zoomed in. This one stays a constant screen size, sits above the plot
// instead of covering it, and flips below when the plot is near the top edge.

import { getPlotColor } from './plot-colors';
import type { PlotStatus } from './plot-types';

export interface PlotTooltipProps {
  plotNumber: number;
  status: PlotStatus;
  statusLabel: string;
  categoryLabel: string;
  /** Anchor as a 0-100 percentage of the map's width/height. */
  anchorXPercent: number;
  anchorYPercent: number;
  tone: 'hover' | 'selected';
}

/** Below this vertical position the callout flips under the plot. */
const FLIP_BELOW_PERCENT = 18;
/** Keeps the callout's centre far enough from the sides that it never clips. */
const EDGE_CLAMP_PERCENT = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function PlotTooltip({
  plotNumber,
  status,
  statusLabel,
  categoryLabel,
  anchorXPercent,
  anchorYPercent,
  tone,
}: PlotTooltipProps) {
  const left = clamp(anchorXPercent, EDGE_CLAMP_PERCENT, 100 - EDGE_CLAMP_PERCENT);
  const below = anchorYPercent < FLIP_BELOW_PERCENT;

  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10"
      style={{
        left: `${left}%`,
        top: `${anchorYPercent}%`,
        transform: below ? 'translate(-50%, 14px)' : 'translate(-50%, calc(-100% - 14px))',
      }}
      data-qa={tone === 'hover' ? 'plot-tooltip' : 'plot-selected-badge'}
    >
      <div
        className={
          'bg-popover text-popover-foreground flex items-center gap-2.5 rounded-lg border px-3 py-2 shadow-lg ' +
          (tone === 'selected' ? 'border-primary' : 'border-border')
        }
      >
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: getPlotColor(status) }}
        />
        <div className="flex flex-col leading-tight whitespace-nowrap">
          <span className="text-sm font-semibold">Plot {plotNumber}</span>
          <span className="text-muted-foreground text-xs">
            {statusLabel} · {categoryLabel}
          </span>
        </div>
      </div>
    </div>
  );
}
