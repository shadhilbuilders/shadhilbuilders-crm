'use client';

// LeadsOverTimeChart - area chart of new leads per day over the last 14 days.
//
// autoplan 2026-09-08 (T3): one of four new dashboard charts fed by the
// /api/dashboard/stats aggregate endpoint. The data-shaping that earns this
// its own file:
//   1. Reads the `leadsOverTime` buckets (already zero-filled server-side to
//      14 days, so the axis never collapses on quiet days).
//   2. Formats the ISO date key to a friendly "Mon 12" label for the axis.
//
// Import pattern (per shadcn charts convention): the wrapper primitives
// (Chart, ChartContainer, ChartTooltip) come from @paalstack/react-ui; the raw
// recharts primitives (Area, AreaChart, XAxis, YAxis) come from recharts.
import {
  Chart,
  ChartContainer,
  ChartTooltip,
} from '@paalstack/react-ui';
import { Area, AreaChart, XAxis, YAxis } from 'recharts';

import { ChartTooltipWithSkeleton } from '@/components/shared/ChartTooltipWithSkeleton';

type LeadsOverTimePoint = { date: string; count: number };

/** Format an ISO date key (yyyy-mm-dd) to a friendly "Mon 12" axis label. */
export function formatDayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' });
}

const LEADS_OVER_TIME_CONFIG = {
  count: { label: 'New leads', color: 'var(--color-primary)' },
} as const;

export type LeadsOverTimeChartProps = {
  data: unknown;
};

/**
 * Renders the 14-day new-leads area chart. Designed to be passed straight
 * into `ChartCard` so the loading/error/empty states stay in one place.
 */
export function LeadsOverTimeChart({ data }: LeadsOverTimeChartProps) {
  if (!Array.isArray(data)) return null;
  const points = (data as LeadsOverTimePoint[]).map((p) => ({
    ...p,
    label: formatDayLabel(p.date),
  }));

  return (
    <Chart config={LEADS_OVER_TIME_CONFIG}>
      <ChartContainer
        config={LEADS_OVER_TIME_CONFIG}
        aria-label="New leads per day, last 14 days"
        className="aspect-auto h-72 w-full"
      >
        <AreaChart data={points} margin={{ top: 8, left: 8, right: 16 }}>
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis allowDecimals={false} />
          <ChartTooltip
            content={(props) => (
              <ChartTooltipWithSkeleton
                {...props}
                renderTooltip={({ label, items }) => (
                  <div className="border-border bg-background min-w-[180px] rounded-md border p-3 shadow-sm">
                    <p className="text-muted-foreground text-xs">{label}</p>
                    {items.map((item) => (
                      <p key={item.label} className="text-sm">
                        <span
                          className="mr-2 inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: item.color }}
                          aria-hidden="true"
                        />
                        {item.label}: {item.value}
                      </p>
                    ))}
                  </div>
                )}
              />
            )}
          />
          <Area
            dataKey="count"
            type="monotone"
            fill="var(--color-count)"
            fillOpacity={0.2}
            stroke="var(--color-count)"
            strokeWidth={2}
          />
        </AreaChart>
      </ChartContainer>
    </Chart>
  );
}
