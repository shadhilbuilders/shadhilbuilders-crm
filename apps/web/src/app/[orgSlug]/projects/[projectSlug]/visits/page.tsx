'use client';

// Site Visits - weekly calendar grid (Wireframes #10).
// 7 days × hourly rows, color-coded by exec per wireframe; "+ Schedule
// visit" opens a Dialog (leads + date/time + exec). Backend visits module
// is pending; data arrives via the locked api-types VisitFilterDto contract.
import { Button, Label, Switch } from '@paalstack/react-ui';
import { LuChevronLeft, LuChevronRight, LuPlus } from '@paalstack/react-icons/lu';
import { useEffect, useState } from 'react';

import { ScheduleVisitDialog } from '@/components/shared/ScheduleVisitDialog';

import { dateIntl } from '@/lib/format';
import { canScheduleVisits, useSessionUser } from '@/lib/session';
import { useProjectId } from '@/lib/tenant-context';

import { PageHeader } from '@/components/shared/PageHeader';
import { SiteVisitCalendar } from '@/components/calendar/site-visit-calendar';
import { VisitColourLegend } from '@/components/calendar/VisitColourLegend';

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

  // T-ProjectSwitch: the calendar shows only the active project's visits.
  // Fetch lives in SiteVisitCalendar (limit 200, no week window). A second
  // week-scoped useVisits here used to gate the Show-past toggle on a query
  // the calendar does not use — if that request lagged, e2e waited 30s for a
  // control that could never mount even though the agenda was fine.
  const projectId = useProjectId() ?? undefined;

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
                  onScheduledDate={(scheduledFor) => {
                    // MOVE THE VIEW TO THE BOOKED DATE.
                    //
                    // The report: "If we create new visits it should reflect in
                    // site calendar immediately without refreshing." The visit
                    // DID reach the calendar via query invalidation, but the
                    // agenda only shows the selected month, so a visit dated
                    // outside it landed off-view and read as a failed create.
                    //
                    // The BOOKED DATE EXACTLY, not its week-start: the calendar's
                    // selected date decides which month renders, and the week
                    // containing the 1st begins in the previous month, so a
                    // week-rounded value shows the wrong month (measured - it
                    // landed on October for a 15 Nov booking).
                    setWeekStart(scheduledFor);
                  }}
                />
              </>
            ) : null}
          </div>
        }
      />

      {/*
        Upcoming / history toggle (owner direction, 2026-09-29: "In visits
        page only show scheduled visit and rescheduled visit and upcoming
        visit data" + "keep toggle"). The calendar defaults to OPEN visits;
        this reveals the closed ones (completed / no-show / cancelled).

        Always mounted (not gated on a fetch): the calendar owns loading.
        Hiding this behind a week-scoped query meant the control never
        appeared if that unused request lagged.

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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Switch
            id="visits-show-past"
            checked={showPast}
            onCheckedChange={setShowPast}
            data-qa="visits-show-past"
            aria-labelledby="visits-show-past-label"
          />
          <Label
            id="visits-show-past-label"
            htmlFor="visits-show-past"
            className="text-muted-foreground inline-flex cursor-pointer items-center gap-2 text-sm font-normal"
          >
            Show past visits
            <span className="text-xs">
              {showPast ? '(including completed, no-show and cancelled)' : '(upcoming only)'}
            </span>
          </Label>
        </div>
        {/*
          The calendar's colours were unexplained (owner: "I don't understand
          what each colors means in visits page card"). Sits with the filter
          both belong to, and toggles independently: the key is about colour,
          the switch is about which visits.
        */}
        <VisitColourLegend />
      </div>
      <SiteVisitCalendar
        projectId={projectId ?? undefined}
        weekStart={weekStart}
        onWeekStartChange={setWeekStart}
        onSlotClick={openSchedule}
        showPast={showPast}
      />
    </div>
  );
}
