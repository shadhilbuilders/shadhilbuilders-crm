'use client';

// PipelineFunnelChart - bucketed lead-status counts, fed to a horizontal
// BarChart so the funnel reads top-to-bottom.
//
// T9 (one of two dedicated files per plan D2; the other is
// VisitsThisWeekChart). The "data shaping" that earns this its own
// file:
//   1. Counts leads per status from the `useLeads` array
//   2. Sorts by the canonical pipeline order (NEW → … → WON), not
//      alphabetical - so the funnel reads left-to-right as a real
//      pipeline, not a jumble of letters
//   3. Applies `labelFor('lead', status)` so the chart axis is the
//      non-technical copy ("Talked", "Visit booked", "Won 🎉") rather
//      than the engineering enum
//
// T11 wired the labels map; this file is where the labels meet real
// data for the first time in a chart axis. Once the leads module
// ships, this component lights up with zero code change - the
// `useLeads` query contract is already locked (api-types).
//
// Import pattern (per shadcn charts convention, see
// https://ui.shadcn.com/docs/components/base/chart): the wrapper
// primitives (Chart, ChartContainer, ChartTooltip, ChartTooltipContent)
// come from @paalstack/react-ui (which owns the theme CSS vars +
// accessibility layer). The raw recharts primitives (Bar, BarChart,
// XAxis, YAxis) come from recharts directly - the library v1.4.1 does
// NOT re-export them, so this is the canonical shadcn split.
import {
  Chart,
  ChartContainer,
  ChartTooltip,
} from '@paalstack/react-ui';
import { Bar, BarChart, XAxis, YAxis } from 'recharts';

import { ChartTooltipWithSkeleton } from '@/components/shared/ChartTooltipWithSkeleton';
import type { LeadStatus } from '@/lib/labels';
import { labelFor, LEAD_STATUSES } from '@/lib/labels';

/** Canonical pipeline order - top of the funnel is `NEW`, bottom is `WON`. */
const PIPELINE_ORDER: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'VISIT_REQUESTED',
  'VISIT_SCHEDULED',
  'VISITED',
  'NEGOTIATION',
  'BOOKING_INITIATED',
  'WON',
];

/** A read-only view of a lead: the `status` field, plus a
 *  structural "is this a lead at all" check. The full `Lead` type lives
 *  in packages/api-types and arrives with the leads module. */
type LeadLike = { status?: string };

function isLeadLike(value: unknown): value is LeadLike {
  return typeof value === 'object' && value !== null;
}

function bucketByStatus(data: unknown[]): Array<{ status: LeadStatus; count: number; label: string }> {
  const counts: Record<string, number> = {};
  for (const item of data) {
    if (!isLeadLike(item)) continue;
    if (typeof item.status !== 'string') continue;
    counts[item.status] = (counts[item.status] ?? 0) + 1;
  }
  return PIPELINE_ORDER.map((status) => ({
    status,
    count: counts[status] ?? 0,
    label: labelFor('lead', status),
  }));
}

const PIPELINE_CONFIG = {
  count: { label: 'Leads', color: 'var(--color-primary)' },
} as const;

export type PipelineFunnelChartProps = {
  data: unknown[];
};

/**
 * Renders the lead-pipeline funnel. Designed to be passed straight
 * into `ChartCard` so the loading/error/empty states stay in one
 * place. Once T19 lands the chart-shape skeleton, this component does
 * not change.
 */
export function PipelineFunnelChart({ data }: PipelineFunnelChartProps) {
  const buckets = bucketByStatus(data);

  return (
    <Chart config={PIPELINE_CONFIG}>
      <ChartContainer
        config={PIPELINE_CONFIG}
        aria-label="Lead pipeline funnel - leads per status"
        className="h-72 w-full"
      >
        <BarChart data={buckets} layout="vertical" margin={{ left: 8, right: 16 }}>
          <XAxis type="number" allowDecimals={false} />
          <YAxis
            dataKey="label"
            type="category"
            width={140}
            tickLine={false}
            axisLine={false}
          />
          <ChartTooltip
            content={(props) => (
              <ChartTooltipWithSkeleton
                {...props}
                formatLabel={(key) => labelFor('lead', key)}
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

// Re-export the constants a test might want to pin.
export { PIPELINE_ORDER, LEAD_STATUSES };
