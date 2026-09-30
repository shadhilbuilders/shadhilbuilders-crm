'use client';

// Site Visits - weekly calendar grid (Wireframes #10).
// 7 days × hourly rows, color-coded by exec per wireframe; "+ Schedule
// visit" opens a Dialog (leads + date/time + exec). Backend visits module
// is pending; data arrives via the locked api-types VisitFilterDto contract.
import { Button, Label, Switch } from '@paalstack/react-ui';
import { LuChevronLeft, LuChevronRight, LuPlus } from '@paalstack/react-icons/lu';
import { useEffect, useMemo, useState } from 'react';

import { ScheduleVisitDialog } from '@/components/shared/ScheduleVisitDialog';
import { Skeleton } from '@/components/shared/Skeleton';

import { useVisits } from '@/hooks/queries/crm';
import { dateIntl } from '@/lib/format';
import { canScheduleVisits, useSessionUser } from '@/lib/session';
import { useProjectId } from '@/lib/tenant-context';

import { PageHeader } from '@/components/shared/PageHeader';
import { SiteVisitCalendar } from '@/components/calendar/site-visit-calendar';

function startOfWeek(date: Date): Date {
  const copy = new Date(date);
  const day = copy.getDay();
  const diff = (day + 6) % 7; // Monday-start week
  copy.setDate(copy.getDate() - diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export default function VisitsPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [slotDate, setSlotDate] = useState<Date | null>(null);
  /**
   * Upcoming vs history (owner direction, 2026-09-29). The page defaults to
   * UPCOMING work; closed visits are one toggle away. Local state, not a URL
   * param: the page has one canonical URL and the toggle is a view preference,
   * not a shareable filter.
   */
  const [showPast, setShowPast] = useState(false);
  const { user } = useSessionUser();
  const [mounted, setMounted] = useState(false);

  // Better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending=true during SSR. Without this gate the
  // server HTML omits the role-gated "Schedule visit" button (user is null
  // during SSR) while hydration adds it → "Hydration failed because the
  // server rendered HTML didn't match the client." Render the same tree for
  // the first client paint, then swap after mount (same pattern as
  // app-header.tsx).
  useEffect(() => {
    setMounted(true);
  }, []);

  /**
   * The query window is the week CONTAINING the view date - derived, never stored.
   *
   * The calendar's selected date and the fetch window are two different things and
   * conflating them was the bug. `weekStart` is the date the calendar is CENTRED
   * on, and the agenda view keys its month off it, so `startOfWeek()` must NOT be
   * applied to it: the week containing the 1st of a month starts in the PREVIOUS
   * month, so a week-rounded selected date renders the wrong month and a visit
   * booked on the 1st lands off-view (measured: booking 2026-11-15 put the header
   * on "October 2026").
   *
   * So the view date stays exact and only the FETCH window is rounded - the window
   * has to contain the booked date, and the Monday of its week always does.
   */
  const from = useMemo(() => startOfWeek(weekStart).toISOString(), [weekStart]);
  const to = useMemo(() => {
    const end = startOfWeek(weekStart);
    end.setDate(end.getDate() + 7);
    return end.toISOString();
  }, [weekStart]);

  // T-ProjectSwitch: the calendar shows only the active project's visits.
  const projectId = useProjectId() ?? undefined;
  const visitsQuery = useVisits({ from, to, projectId });

  function shiftWeek(delta: number) {
    setWeekStart((current) => {
      const next = new Date(current);
      next.setDate(next.getDate() + delta * 7);
      return next;
    });
  }

  function openSchedule(date: Date) {
    setSlotDate(date);
    setScheduleOpen(true);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Site Visits"
        breadcrumb={[{ label: 'Work' }, { label: 'Visits' }]}
        subtitle={
          <>
            Week of{' '}
            {dateIntl.format(weekStart, 'd MMM yyyy')}
          </>
        }
        action={
          <div className="flex items-center gap-2">
            {!visitsQuery.isLoading ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => shiftWeek(-1)}
                  leftIcon={<LuChevronLeft className="size-4" />}
                >
                  Prev
                </Button>
                <Button
                  variant="outline"
                  onClick={() => shiftWeek(1)}
                  rightIcon={<LuChevronRight className="size-4" />}
                >
                  Next
                </Button>
              </>
            ) : null}
            {mounted && canScheduleVisits(user?.role) ? (
              <>
                <Button
                  onClick={() => openSchedule(new Date())}
                  data-qa="schedule-visit-button"
                  leftIcon={<LuPlus className="size-4" />}
                >
                  Schedule visit
                </Button>
                <ScheduleVisitDialog
                  open={scheduleOpen}
                  onOpenChange={setScheduleOpen}
                  initialDate={slotDate ?? undefined}
                  onCreated={() => {
                    // Refetch the current week's visits so the new visit
                    // shows up on the calendar immediately. (The create
                    // mutation also invalidates ['visits'] globally, but
                    // this guarantees the page's exact query refetches.)
                    void visitsQuery.refetch();
                  }}
                  onScheduledDate={(scheduledFor) => {
                    // MOVE THE VIEW TO THE BOOKED DATE.
                    //
                    // The report: "If we create new visits it should reflect in
                    // site calendar immediately without refreshing." The invalidate
                    // and refetch were already correct - the visit DID reach the
                    // calendar - but the calendar renders only the period it is
                    // showing, so a visit dated outside it landed off-view and the
                    // user read that as a failed create.
                    //
                    // The BOOKED DATE EXACTLY, not its week-start: the calendar's
                    // selected date decides which month renders, and the week
                    // containing the 1st begins in the previous month, so a
                    // week-rounded value shows the wrong month (measured - it
                    // landed on October for a 15 Nov booking). The fetch window is
                    // rounded separately, in the derived `from`/`to` above.
                    //
                    // A booking in the displayed month leaves the view where it
                    // was, since the date is already inside that month.
                    setWeekStart(scheduledFor);
                  }}
                />
              </>
            ) : null}
          </div>
        }
      />

      {visitsQuery.isLoading ? (
        <Skeleton variant="card" />
      ) : (
        <>
          {/*
            Upcoming / history toggle (owner direction, 2026-09-29: "In visits
            page only show scheduled visit and rescheduled visit and upcoming
            visit data" + "keep toggle"). The calendar defaults to OPEN visits;
            this reveals the closed ones (completed / no-show / cancelled).

            A Switch rather than two tabs because there are only two states and
            neither is a URL-worthy route - keeping it out of searchParams means
            the page has one canonical URL and no back-button surprises.

            Uses the design-system Switch (owner direction: "for Show past visits
            use Switch Component"), not a raw <input type="checkbox">. The label
            pair matches the established pattern in settings/page.tsx and
            teams/team-form-bodies.tsx: <Switch id> + <Label htmlFor>, wired to
            the same state. `aria-label` is deliberately omitted because the
            visible <Label> already names the control - setting both would make a
            screen reader announce the name twice.
          */}
          <div className="flex items-center gap-2">
            <Switch
              id="visits-show-past"
              checked={showPast}
              onCheckedChange={setShowPast}
              data-qa="visits-show-past"
            />
            <Label
              htmlFor="visits-show-past"
              className="text-muted-foreground inline-flex cursor-pointer items-center gap-2 text-sm font-normal"
            >
              Show past visits
              <span className="text-xs">
                {showPast ? '(including completed, no-show and cancelled)' : '(upcoming only)'}
              </span>
            </Label>
          </div>
          <SiteVisitCalendar
            projectId={projectId ?? undefined}
            weekStart={weekStart}
            onWeekStartChange={setWeekStart}
            onSlotClick={openSchedule}
            showPast={showPast}
          />
        </>
      )}
    </div>
  );
}
