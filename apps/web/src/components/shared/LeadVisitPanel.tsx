'use client';

// LeadVisitPanel — visit scheduling + outcome buttons on the lead
// detail page. Shows different UI based on the lead's current state:
//
//   - VISIT_REQUESTED: "Schedule visit" button (opens dialog)
//   - VISIT_SCHEDULED: "Mark visit completed" + "No-show" buttons
//     (records outcome, drives lead state on COMPLETED)
//   - Other states: hidden
//
// The dialog and outcome mutations use the same `useCreateVisit` /
// `useUpdateVisitOutcome` hooks as the visits page. Server-side, the
// visits service calls `LeadsService.transition()` to drive the parent
// lead state, so this panel's UI doesn't have to coordinate two
// round-trips.
import { useState } from 'react';

import { Button, Card, CardContent, CardHeader, CardTitle, toast } from '@paalstack/react-ui';

import { ScheduleVisitDialog } from '@/components/shared/ScheduleVisitDialog';
import {
  useUpdateVisitOutcome,
  useVisits,
} from '@/hooks/queries/crm';
import { canScheduleVisits, useSessionUser } from '@/lib/session';

type LeadData = {
  id: string;
  status?: string;
};

export function LeadVisitPanel({ lead }: { lead: LeadData }) {
  const { user } = useSessionUser();
  const status = typeof lead.status === 'string' ? lead.status : '';
  const [scheduleOpen, setScheduleOpen] = useState(false);

  // For VISIT_SCHEDULED, we need the open visit row to record an
  // outcome. Fetch with a wide time window — there should be at most
  // one open visit per lead (RLS + service rules).
  const visitsQuery = useVisits({});
  const openVisit = Array.isArray(visitsQuery.data)
    ? (visitsQuery.data as { id: string; leadId: string; status: string }[]).find(
        (v) => v.leadId === lead.id && (v.status === 'SCHEDULED' || v.status === 'NO_SHOW'),
      )
    : undefined;
  const updateOutcome = useUpdateVisitOutcome(openVisit?.id ?? null);

  const showSchedule = status === 'VISIT_REQUESTED' || status === 'RESCHEDULED';
  const showOutcome =
    status === 'VISIT_SCHEDULED' && openVisit !== undefined && canScheduleVisits(user?.role);

  if (!showSchedule && !showOutcome) return null;

  function recordOutcome(outcome: 'COMPLETED' | 'NO_SHOW' | 'CANCELLED') {
    if (openVisit === undefined) return;
    updateOutcome.mutate(
      // visitId is in the URL path; the hook's mutationFn ignores the
      // body value (the controller adds it from :id). Pass it anyway
      // to satisfy the DTO type.
      { visitId: openVisit.id, outcome, notes: '' },
      {
        onSuccess: () => toast.success(`Visit ${outcome.toLowerCase()}`),
        onError: (e) =>
          toast.error(e instanceof Error ? e.message : 'Outcome failed'),
      },
    );
  }

  return (
    <Card data-qa="lead-visit-panel">
      <CardHeader>
        <CardTitle className="text-base">Visit</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {showSchedule && canScheduleVisits(user?.role) ? (
          <>
            <p className="text-muted-foreground text-sm">
              The lead is ready for a site visit — pick a date/time and
              (optionally) the sales exec who'll conduct it.
            </p>
            <Button
              type="button"
              size="sm"
              variant="default"
              onClick={() => setScheduleOpen(true)}
              data-qa="lead-schedule-visit"
            >
              Schedule visit
            </Button>
            <ScheduleVisitDialog
              open={scheduleOpen}
              onOpenChange={setScheduleOpen}
              initialLeadId={lead.id}
              hideLeadPicker
            />
          </>
        ) : null}

        {showOutcome ? (
          <>
            <p className="text-muted-foreground text-sm">
              Visit is scheduled. Record what happened on site.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={() => recordOutcome('COMPLETED')}
                disabled={updateOutcome.isPending}
                data-qa="visit-mark-completed"
              >
                Mark completed
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => recordOutcome('NO_SHOW')}
                disabled={updateOutcome.isPending}
                data-qa="visit-mark-no-show"
              >
                No-show
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => recordOutcome('CANCELLED')}
                disabled={updateOutcome.isPending}
                data-qa="visit-mark-cancelled"
              >
                Cancel visit
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
