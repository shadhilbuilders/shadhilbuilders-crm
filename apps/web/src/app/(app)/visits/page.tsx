'use client';

// Site Visits — weekly calendar grid (Wireframes #10).
// 7 days × hourly rows, color-coded by exec per wireframe; "+ Schedule
// visit" opens a Dialog (leads + date/time + exec). Backend visits module
// is pending; data arrives via the locked api-types VisitFilterDto contract.
import {
  Button,
  Dialog,
  TypographyP,
} from '@paalstack/react-ui';
import { LuPlus } from '@paalstack/react-icons/lu';
import { useMemo, useState } from 'react';

import { ModulePending } from '@/components/shared/ModulePending';
import { Skeleton } from '@/components/shared/Skeleton';
import { useVisits } from '@/hooks/queries/crm';
import { canScheduleVisits, useSessionUser } from '@/lib/session';

import { PageHeader } from '../PageHeader';

const HOURS = [9, 10, 11, 12, 14, 15, 16, 17] as const;

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
  const { user } = useSessionUser();

  const from = useMemo(() => weekStart.toISOString(), [weekStart]);
  const to = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 7);
    return end.toISOString();
  }, [weekStart]);

  const visitsQuery = useVisits({ from, to });

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + index);
      return day;
    });
  }, [weekStart]);

  function shiftWeek(delta: number) {
    setWeekStart((current) => {
      const next = new Date(current);
      next.setDate(next.getDate() + delta * 7);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Site Visits"
        breadcrumb={[{ label: 'Work' }, { label: 'Visits' }]}
        subtitle={
          <>
            Week of{' '}
            {weekStart.toLocaleDateString('en-IN', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </>
        }
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={() => shiftWeek(-1)}
            >
              ← Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={() => shiftWeek(1)}
            >
              Next →
            </Button>
            {canScheduleVisits(user?.role) ? (
              <Dialog
                trigger={
                  <Button size="sm" className="min-h-11">
                    <LuPlus className="mr-1 h-4 w-4" /> Schedule visit
                  </Button>
                }
                header={{ title: 'Schedule a site visit' }}
                footer={
                  <div className="flex w-full justify-end gap-2">
                    <Button variant="ghost" onClick={() => setScheduleOpen(false)}>
                      Cancel
                    </Button>
                    <Button disabled title="Requires the visits module (Week 6)">
                      Schedule
                    </Button>
                  </div>
                }
                open={scheduleOpen}
                onOpenChange={setScheduleOpen}
              >
                <div className="space-y-3 text-sm">
                  <TypographyP className="text-muted-foreground">
                    Pick a lead, a date/time slot, and (optionally) the sales
                    exec who conducts the visit. The form activates when the
                    visits module ships (Week 6).
                  </TypographyP>
                  <div className="border-border rounded-md border border-dashed p-6 text-center text-xs">
                    Form fields locked to{' '}
                    <code>CreateSiteVisitDtoSchema</code>: leadId ·
                    scheduledFor · salesExecId · notes
                  </div>
                </div>
              </Dialog>
            ) : null}
          </div>
        }
      />

      {visitsQuery.isLoading ? (
        <Skeleton variant="card" />
      ) : visitsQuery.data !== undefined && Array.isArray(visitsQuery.data) ? (
        <WeekGrid days={weekDays} visits={visitsQuery.data} />
      ) : (
        <>
          {/* Grid chrome renders even in pending state so the surface is real */}
          <WeekGrid days={weekDays} visits={[]} pending />
          <ModulePending
            title="Site visit scheduler"
            description="Weekly calendar of visits by exec, with schedule/no-show/reschedule outcomes (Wireframe #10). The visits module ships in Implementation Plan Week 6."
            error={visitsQuery.error}
          />
        </>
      )}
    </div>
  );
}

function WeekGrid({
  days,
  visits,
  pending = false,
}: {
  days: Date[];
  visits: unknown[];
  pending?: boolean;
}) {
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr>
            <th className="border-border w-16 border-b px-2 py-2" />
            {days.map((day) => {
              const isToday = new Date().toDateString() === day.toDateString();
              return (
                <th
                  key={day.toISOString()}
                  className={`border-border border-b px-2 py-2 text-center text-xs font-medium ${
                    isToday ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {day.toLocaleDateString('en-IN', {
                    weekday: 'short',
                    day: 'numeric',
                  })}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {HOURS.map((hour) => (
            <tr key={hour}>
              <td className="border-border text-muted-foreground border-b px-2 py-3 text-xs tabular-nums">
                {String(hour).padStart(2, '0')}:00
              </td>
              {days.map((day) => {
                const cellVisits = pending
                  ? []
                  : (visits as { scheduledAt?: string }[]).filter((visit) => {
                      if (visit.scheduledAt === undefined) return false;
                      const visitDate = new Date(visit.scheduledAt);
                      return (
                        visitDate.getDate() === day.getDate() &&
                        visitDate.getMonth() === day.getMonth() &&
                        visitDate.getHours() === hour
                      );
                    });
                return (
                  <td
                    key={`${hour}-${day.toISOString()}`}
                    className="border-border border-b px-1.5 py-1.5 align-top"
                  >
                    {cellVisits.length > 0
                      ? cellVisits.map((visit, index) => (
                          <div
                            key={index}
                            className="bg-primary/10 text-primary rounded px-1.5 py-1 text-xs"
                          >
                            {new Date(visit.scheduledAt ?? '').toLocaleTimeString('en-IN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                        ))
                      : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}