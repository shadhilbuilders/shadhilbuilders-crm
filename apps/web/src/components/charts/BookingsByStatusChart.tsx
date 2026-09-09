'use client';

// BookingsByStatusChart - horizontal bar of bookings per status.
//
// autoplan 2026-09-08: companion to TeamPerformanceChart in the dashboard's
// 2-column grid. Fed by the /api/dashboard/stats aggregate endpoint's
// `bookingsByStatus` buckets (status + count). Uses a horizontal bar so the
// friendly status labels (On hold, Token, Approved, …) read left-to-right.
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
import { labelFor, BOOKING_STATUSES, type BookingStatus } from '@/lib/labels';

type BookingsByStatusRow = { status: string; count: number };

const BOOKINGS_CONFIG = {
  count: { label: 'Bookings', color: 'var(--color-chart-2)' },
} as const;

function isBookingStatus(value: string): value is BookingStatus {
  return (BOOKING_STATUSES as readonly string[]).includes(value);
}

export type BookingsByStatusChartProps = {
  data: unknown;
};

/**
 * Renders the bookings-by-status horizontal bar chart. Designed to be passed
 * straight into `ChartCard` so the loading/error/empty states stay in one place.
 */
export function BookingsByStatusChart({ data }: BookingsByStatusChartProps) {
  if (!Array.isArray(data)) return null;
  const rows = (data as BookingsByStatusRow[])
    .filter((r) => r.count > 0)
    .map((r) => ({
      ...r,
      label: isBookingStatus(r.status) ? labelFor('booking', r.status) : r.status,
    }))
    .sort((a, b) => b.count - a.count);

  return (
    <Chart config={BOOKINGS_CONFIG}>
      <ChartContainer
        config={BOOKINGS_CONFIG}
        aria-label="Bookings by status"
        className="aspect-auto h-72 w-full"
      >
        <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
          <XAxis type="number" allowDecimals={false} />
          <YAxis
            dataKey="label"
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
