'use client';

// TeamPerformanceChart - horizontal bar of leads per owner.
//
// autoplan 2026-09-08 (T3): one of four new dashboard charts fed by the
// /api/dashboard/stats aggregate endpoint. The data-shaping that earns this
// its own file:
//   1. Reads the `teamPerformance` buckets (ownerId + ownerName + count).
//   2. Sorts by count descending so the busiest owner is at the top.
//   3. Uses a horizontal bar so owner names read left-to-right.
//
// Import pattern (per shadcn charts convention): the wrapper primitives
// (Chart, ChartContainer, ChartTooltip) come from @paalstack/react-ui; the raw
// recharts primitives (Bar, BarChart, XAxis, YAxis) come from recharts.
import {
  Chart,
  ChartContainer,
  ChartTooltip,
} from '@paalstack/react-ui';
import { Bar, BarChart, XAxis, YAxis } from 'recharts';

import { ChartTooltipWithSkeleton } from '@/components/shared/ChartTooltipWithSkeleton';

type TeamPerformanceRow = { ownerId: string; ownerName: string; count: number };

const TEAM_PERFORMANCE_CONFIG = {
  count: { label: 'Leads', color: 'var(--color-primary)' },
} as const;

export type TeamPerformanceChartProps = {
  data: unknown;
};

/**
 * Renders the team-performance horizontal bar chart. Designed to be passed
 * straight into `ChartCard` so the loading/error/empty states stay in one place.
 */
export function TeamPerformanceChart({ data }: TeamPerformanceChartProps) {
  if (!Array.isArray(data)) return null;
  const rows = (data as TeamPerformanceRow[])
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);

  return (
    <Chart config={TEAM_PERFORMANCE_CONFIG}>
      <ChartContainer
        config={TEAM_PERFORMANCE_CONFIG}
        aria-label="Leads per team member"
        className="aspect-auto h-72 w-full"
      >
        <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
          <XAxis type="number" allowDecimals={false} />
          <YAxis
            dataKey="ownerName"
            type="category"
            width={120}
            tickLine={false}
            axisLine={false}
          />
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
          <Bar
            dataKey="count"
            fill="var(--color-count)"
            radius={4}
          />
        </BarChart>
      </ChartContainer>
    </Chart>
  );
}
