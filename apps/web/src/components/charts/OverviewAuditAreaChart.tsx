'use client';

// OverviewAuditAreaChart - interactive area chart of audit activity over time.
//
// Redesign (2026-09-10): the /overview command center's headline chart.
// Fed by the REAL `auditTimeline` series from GET /api/dashboard/overview
// (90 days, zero-filled server-side). The user picks 7d / 30d / 90d via a
// ToggleGroup (desktop) or Select (mobile); the client filters the series
// to the chosen window - no fabricated data, the range picker only narrows
// the real series.
//
// Import pattern (per shadcn charts convention): the wrapper primitives
// (Chart, ChartContainer, ChartTooltip, ChartTooltipContent) come from
// @paalstack/react-ui; the raw recharts primitives (Area, AreaChart,
// CartesianGrid, XAxis) come from recharts.
import * as React from 'react';
import {
  Chart,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  ToggleGroup,
} from '@paalstack/react-ui';
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts';

import { useMediaQuery } from '@paalstack/react-hooks';

type AuditTimelinePoint = { date: string; count: number };

const RANGE_OPTIONS = [
  { value: '90d', label: 'Last 3 months' },
  { value: '30d', label: 'Last 30 days' },
  { value: '7d', label: 'Last 7 days' },
] as const;

type RangeKey = (typeof RANGE_OPTIONS)[number]['value'];

const AUDIT_CONFIG = {
  count: { label: 'Audit events', color: 'var(--color-primary)' },
} as const;

/** Format an ISO date key (yyyy-mm-dd) to a friendly "Sep 10" axis label. */
function formatDayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export type OverviewAuditAreaChartProps = {
  data: unknown;
};

/**
 * Renders the interactive audit-activity area chart. The 90-day series is
 * filtered client-side to the selected range (7d/30d/90d). Designed to be
 * passed straight into `ChartCard` so the loading/error/empty states stay
 * in one place.
 */
export function OverviewAuditAreaChart({ data }: OverviewAuditAreaChartProps) {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [timeRange, setTimeRange] = React.useState<RangeKey>('90d');

  // On mobile the ToggleGroup is hidden in favor of the Select; default to
  // the 7-day window so the smaller chart isn't crowded with 90 points.
  React.useEffect(() => {
    if (isMobile) setTimeRange('7d');
  }, [isMobile]);

  if (!Array.isArray(data)) return null;
  const points = (data as AuditTimelinePoint[]).map((p) => ({
    ...p,
    label: formatDayLabel(p.date),
  }));

  const daysToSubtract = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90;
  const referenceDate = new Date();
  const startDate = new Date(referenceDate);
  startDate.setDate(startDate.getDate() - daysToSubtract);
  const startKey = startDate.toLocaleDateString('en-CA');

  const filteredData = points.filter((item) => item.date >= startKey);

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Audit activity</CardTitle>
        <CardDescription>
          <span className="hidden @[540px]/card:block">System events across all projects</span>
          <span className="@[540px]/card:hidden">System events</span>
        </CardDescription>
        <CardAction>
          <ToggleGroup
            type="single"
            value={timeRange}
            onValueChange={(value) => setTimeRange((value as RangeKey) || '90d')}
            variant="outline"
            className="hidden *:data-[slot=toggle-group-item]:px-4! @[767px]/card:flex"
            items={RANGE_OPTIONS.map((o) => ({ value: o.value, content: o.label }))}
          />
          <Select
            value={timeRange}
            onValueChange={(value) => setTimeRange((value as RangeKey) || '90d')}
            options={RANGE_OPTIONS.map((o) => ({ value: o.value, label: o.label, key: o.value }))}
            placeholder="Last 3 months"
            className="w-40 @[767px]/card:hidden"
            triggerClassName="w-40"
          />
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <Chart config={AUDIT_CONFIG}>
          <ChartContainer
            config={AUDIT_CONFIG}
            aria-label="Audit events per day, last 3 months"
            className="aspect-auto h-[250px] w-full"
          >
            <AreaChart data={filteredData} margin={{ top: 8, left: 8, right: 16 }}>
              <defs>
                <linearGradient id="fillAudit" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-count)" stopOpacity={1.0} />
                  <stop offset="95%" stopColor="var(--color-count)" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
              <Area
                dataKey="count"
                type="natural"
                fill="url(#fillAudit)"
                stroke="var(--color-count)"
                stackId="a"
              />
            </AreaChart>
          </ChartContainer>
        </Chart>
      </CardContent>
    </Card>
  );
}
