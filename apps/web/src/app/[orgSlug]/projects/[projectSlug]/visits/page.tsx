'use client';

// Site Visits - weekly calendar grid (Wireframes #10).
// 7 days × hourly rows, color-coded by exec per wireframe; "+ Schedule
// visit" opens a Dialog (leads + date/time + exec). Backend visits module
// is pending; data arrives via the locked api-types VisitFilterDto contract.
import { Button } from '@paalstack/react-ui';
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

  const from = useMemo(() => weekStart.toISOString(), [weekStart]);
  const to = useMemo(() => {
    const end = new Date(weekStart);
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
                />
              </>
            ) : null}
          </div>
        }
      />

      {visitsQuery.isLoading ? (
        <Skeleton variant="card" />
      ) : (
        <SiteVisitCalendar
          projectId={projectId ?? undefined}
          weekStart={weekStart}
          onWeekStartChange={setWeekStart}
          onSlotClick={openSchedule}
        />
      )}
    </div>
  );
}
