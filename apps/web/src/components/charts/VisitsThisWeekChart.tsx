'use client';

// VisitsThisWeekChart - a 7-day vertical bar chart of visit counts.
//
// T9 (the other dedicated file per plan D2). The "data shaping" that
// earns this its own file:
//   1. Window computation: Mon–Sun of the current week, derived from
//      `new Date()` so the chart is always "this week" without a
//      date-picker UI on the dashboard.
//   2. Zero-fill: days with no visits still show as a 0-height bar so
//      the X-axis spacing doesn't collapse (otherwise Mon shows 0 and
//      the layout is wrong on a quiet day).
//   3. Timezone-correct: `toLocaleDateString` is used for grouping so
//      the bucketing matches what the user sees on the calendar grid
//      on `/visits` (en-IN locale, same as VisitsPage).
//
// T11's label map is not needed here because the axis labels are
// weekdays (already friendly), not enums.
//
// Import pattern (per shadcn charts convention, see
// https://ui.shadcn.com/docs/components/base/chart): the wrapper
// primitives (Chart, ChartContainer, ChartTooltip, ChartTooltipContent)
// come from @paalstack/react-ui (which owns the theme CSS vars +
// accessibility layer). The raw recharts primitives (Bar, BarChart,
// XAxis, YAxis) come from recharts directly - the library v1.4.1 does
// NOT re-export them, so this is the canonical shadcn split.
//
// Recharts BarChart API: when `layout="vertical"` (or default with
// categorical X + numeric Y), the props on XAxis/YAxis swap roles.
// This chart uses the default horizontal layout so XAxis is
// categorical (weekday) and YAxis is numeric (count). See
// https://recharts.github.io/en-US/api/BarChart/ for the API reference.
import {
  Chart,
  ChartContainer,
  ChartTooltip,
} from '@paalstack/react-ui';
import { Bar, BarChart, XAxis, YAxis } from 'recharts';

import { ChartTooltipWithSkeleton } from '@/components/shared/ChartTooltipWithSkeleton';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

type DayBucket = { day: string; count: number; iso: string };

/** Monday-start week containing `now`. */
function startOfWeek(now: Date): Date {
  const copy = new Date(now);
  const day = copy.getDay(); // 0 = Sunday
  const diff = (day + 6) % 7; // shift so Monday = 0
  copy.setDate(copy.getDate() - diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

type VisitLike = { scheduledAt?: string; scheduledFor?: string };

function isoDay(value: string): string {
  // Group by en-IN calendar day so the buckets line up with what the
  // user sees in `WeekGrid` on /visits. `toLocaleDateString('en-CA')`
  // returns ISO-format yyyy-mm-dd, which is a stable bucket key.
  return new Date(value).toLocaleDateString('en-CA');
}

function bucketByDay(data: unknown[], weekStart: Date): DayBucket[] {
  const counts: Record<string, number> = {};
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const visit = item as VisitLike;
    const when = visit.scheduledAt ?? visit.scheduledFor;
    if (typeof when !== 'string') continue;
    const key = isoDay(when);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(weekStart);
    day.setDate(day.getDate() + index);
    const key = day.toLocaleDateString('en-CA');
    return {
      day: DAY_LABELS[index] ?? '?',
      iso: key,
      count: counts[key] ?? 0,
    };
  });
}

const VISITS_CONFIG = {
  count: { label: 'Visits', color: 'var(--color-primary)' },
} as const;

export type VisitsThisWeekChartProps = {
  data: unknown[];
};

/**
 * Renders the rolling 7-day visit count for the current week. The
 * bucketing is a pure function of `data` + the local clock, so it
 * can be unit-tested without rendering (`visits-week.test.ts` per
 * plan T9).
 */
export function VisitsThisWeekChart({ data }: VisitsThisWeekChartProps) {
  const weekStart = startOfWeek(new Date());
  const buckets = bucketByDay(data, weekStart);

  return (
    <Chart config={VISITS_CONFIG}>
      <ChartContainer
        config={VISITS_CONFIG}
        aria-label="Visits this week - count per day, Monday to Sunday"
        className="h-72 w-full"
      >
        <BarChart data={buckets} margin={{ top: 8, left: 8, right: 16 }}>
          <XAxis dataKey="day" tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} />
          <ChartTooltip
            content={(props) => (
              <ChartTooltipWithSkeleton
                {...props}
                renderTooltip={({ label, items }: { label: string; items: Array<{ label: string; value: string; color?: string }> }) => (
                  <div className="border-border bg-background min-w-[180px] rounded-md border p-3 shadow-sm">
                    <p className="text-muted-foreground text-xs">{label}</p>
                    {items.map((item: { label: string; value: string; color?: string }) => (
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

// Re-exported for the test that pins the bucketing contract.
export { startOfWeek, bucketByDay, type DayBucket };
