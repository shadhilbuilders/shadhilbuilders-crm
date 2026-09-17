'use client';

// TodayVisitsCard - today's scheduled site visits (T-DASH-QUEUE, 2026-09-16).
//
// Extracted from the dashboard page, which had grown past the point where a
// single file stays reviewable. This section is self-contained: it reads only
// its own query result, its own loading/empty state, and the two slugs it needs
// for links.
//
// WHY IT RENDERS IN BOTH ROLE VIEWS: a visit is the one item on this page with
// a CLOCK on it, so it sorts above the queue. For a SALES_EXEC it is the
// primary surface (the visits they are conducting today); for a TELECALLER it
// is confirmation work on visits they booked; for a manager it is the team's day.
//
// The row leads with the TIME, then the lead name, then the assigned exec. The
// lead name links to the lead's own page rather than opening anything inline:
// this card is a schedule, and the action surface for a visit lives in the
// queue row and the lead page.

import { Button } from '@paalstack/react-ui';
import Link from 'next/link';

import { SectionCard } from '@/components/dashboard/dashboard-shared';
import { Skeleton } from '@/components/shared/Skeleton';
import { dateIntl } from '@/lib/format';
import { projectHref } from '@/lib/nav';

/** The fields this card reads off a visit list row. */
type VisitListRow = {
  id: string;
  leadId?: string;
  leadName?: string;
  scheduledFor?: string;
  userName?: string;
};

export function TodayVisitsCard({
  visits,
  isLoading,
  isExec,
  orgSlug,
  projectSlug,
}: {
  visits: unknown[];
  isLoading: boolean;
  isExec: boolean;
  orgSlug: string | null;
  projectSlug: string | null;
}) {
  const rows = visits as VisitListRow[];

  return (
    <SectionCard title={isExec ? "Today's visits to conduct" : "Today's visits"}>
      {isLoading ? (
        <Skeleton variant="list" count={2} />
      ) : rows.length === 0 ? (
        // A real empty state, not a blank panel: the telecaller needs to know
        // the difference between "none scheduled" and "failed to load".
        <p className="text-muted-foreground text-sm">No visits scheduled today.</p>
      ) : (
        <ul role="list" className="divide-border divide-y">
          {rows.map((visit) => {
            const leadId = typeof visit.leadId === 'string' ? visit.leadId : null;
            return (
              <li
                key={visit.id}
                className="flex flex-col sm:flex-row flex-wrap items-start sm:items-center justify-start sm:justify-between gap-x-4 gap-y-1 py-2 text-sm"
              >
                <div className="flex items-center gap-3">
                  <span className="shrink-0 tabular-nums">
                    {/* Was a hand-rolled `toLocaleTimeString`, which the standing
                        formatting convention forbids ("never hand-rolled Intl -
                        always currencyIntl / dateIntl / numberIntl"). `DateIntl`
                        has no formatTime, so the time-only pattern is passed as
                        the format string; the instance supplies the locale and
                        the '-' fallback for a missing value. */}
                    {dateIntl.format(visit.scheduledFor, 'hh:mm a')}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={visit.leadName ?? ''}>
                    {leadId !== null ? (
                      // Button variant="link" already carries
                      // `underline-offset-4 hover:underline` - the underline appears
                      // on hover only, and there is no second copy to drift from it.
                      // `text-link` overrides the variant's `text-primary`: --link
                      // (the app's blue) is a DIFFERENT token from --primary (navy).
                      <Button
                        as={Link}
                        variant="link"
                        href={projectHref(orgSlug, projectSlug, `/leads/${leadId}`)}
                        className="text-link"
                      >
                        {visit.leadName ?? leadId}
                      </Button>
                    ) : (
                      (visit.leadName ?? '-')
                    )}
                  </span>
                </div>
                <span className="text-muted-foreground text-xs">
                  {visit.userName ?? 'unassigned'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
