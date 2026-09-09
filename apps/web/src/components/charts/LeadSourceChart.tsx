'use client';

// LeadSourceChart - donut/pie of lead counts by source.
//
// autoplan 2026-09-08 (T3): one of four new dashboard charts fed by the
// /api/dashboard/stats aggregate endpoint. The data-shaping that earns this
// its own file:
//   1. Reads the `leadSources` buckets (source + count).
//   2. Maps the raw source enum to a friendly label via `labelFor('source', ...)`
//      so a non-technical user reads "Meta ads" not "META_AD".
//   3. Assigns a stable color per source so the donut is readable.
//
// Import pattern (per shadcn charts convention): the wrapper primitives
// (Chart, ChartContainer, ChartTooltip) come from @paalstack/react-ui; the raw
// recharts primitives (Pie, PieChart, Cell) come from recharts.
import {
  Chart,
  ChartContainer,
  ChartTooltip,
} from '@paalstack/react-ui';
import { Cell, Pie, PieChart } from 'recharts';

import { ChartTooltipWithSkeleton } from '@/components/shared/ChartTooltipWithSkeleton';
import { labelFor } from '@/lib/labels';

type LeadSourceSlice = { source: string; count: number };

/** Stable color per source index (recharts Cell fill). */
const SOURCE_COLORS = [
  'var(--color-primary)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
];

const LEAD_SOURCE_CONFIG = {
  count: { label: 'Leads', color: 'var(--color-primary)' },
} as const;

export type LeadSourceChartProps = {
  data: unknown;
};

/**
 * Renders the lead-source donut. Designed to be passed straight into
 * `ChartCard` so the loading/error/empty states stay in one place.
 */
export function LeadSourceChart({ data }: LeadSourceChartProps) {
  if (!Array.isArray(data)) return null;
  // Dedupe by friendly label: legacy rows may carry a humanized source
  // ("Landing site") alongside the canonical enum ("LANDING"), which both
  // render as the same label and would otherwise produce duplicate React
  // keys. Merge their counts so the donut stays unique-keyed.
  const byLabel = new Map<string, { name: string; value: number; fill: string }>();
  let colorIndex = 0;
  for (const s of data as LeadSourceSlice[]) {
    if (typeof s?.count !== 'number' || s.count <= 0) continue;
    const name = labelFor('source', s.source);
    const existing = byLabel.get(name);
    if (existing) {
      existing.value += s.count;
    } else {
      byLabel.set(name, {
        name,
        value: s.count,
        fill: SOURCE_COLORS[colorIndex % SOURCE_COLORS.length]!,
      });
      colorIndex += 1;
    }
  }
  const slices = [...byLabel.values()];
  if (slices.length === 0) return null;

  return (
    <Chart config={LEAD_SOURCE_CONFIG}>
      <ChartContainer
        config={LEAD_SOURCE_CONFIG}
        aria-label="Lead counts by source"
        className="aspect-auto h-72 w-full"
      >
        <PieChart margin={{ top: 8, left: 8, right: 8, bottom: 8 }}>
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
          <Pie
            data={slices}
            dataKey="value"
            nameKey="name"
            innerRadius={60}
            outerRadius={100}
            paddingAngle={2}
          >
            {slices.map((slice) => (
              <Cell key={slice.name} fill={slice.fill} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
    </Chart>
  );
}
