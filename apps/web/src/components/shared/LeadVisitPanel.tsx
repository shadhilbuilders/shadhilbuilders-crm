'use client';

// LeadVisitPanel - visit scheduling + outcome buttons on the lead
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
import { canLogVisitOutcome, canScheduleVisits, useSessionUser } from '@/lib/session';
import { queue } from '@/lib/offline-store/queue-store';

type LeadData = {
  id: string;
  status?: string;
};

/**
 * T-D4 - is this failure the "we're offline" case (queue it for later
 * replay) or a real server rejection (surface to the user)?
 *
 * Offline queueing is for TRANSPORT failures only:
 *   - TypeError: Failed to fetch (the browser can't reach the server -
 *     classic offline signal)
 *   - 5xx ApiError (server-side problem; the SW replays later)
 *
 * A 4xx is a REAL rejection (validation, state-machine guard,
 * permissions) - queueing it would poison the offline queue with an
 * entry that can never succeed, so it surfaces as a toast instead.
 */
export function isOfflineError(err: unknown): boolean {
  if (err instanceof TypeError) {
    return /Failed to fetch|NetworkError|fetch failed|Load failed/i.test(err.message);
  }
  if (err instanceof Error && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' && status >= 500;
  }
  return false;
}

export function LeadVisitPanel({ lead }: { lead: LeadData }) {
  const { user } = useSessionUser();
  const status = typeof lead.status === 'string' ? lead.status : '';
  const [scheduleOpen, setScheduleOpen] = useState(false);

  // For VISIT_SCHEDULED, we need the open visit row to record an
  // outcome. Fetch with a wide time window - there should be at most
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
    const body = { visitId: openVisit.id, outcome, notes: '' };
    updateOutcome.mutate(
      // visitId is in the URL path; the hook's mutationFn ignores the
      // body value (the controller adds it from :id). Pass it anyway
      // to satisfy the DTO type.
      body,
      {
        onSuccess: () => toast.success(`Visit ${outcome.toLowerCase()}`),
        onError: (e) => {
          // T-D4: transport failure (offline / 5xx) → save locally and
          // let the offline queue replay it on reconnect. The backend's
          // idempotent-replay rule makes a replayed outcome a no-op if
          // it already landed, so retries converge. 4xx stays a real
          // error (queueing it would poison the queue).
          if (!isOfflineError(e)) {
            toast.error(e instanceof Error ? e.message : 'Outcome failed');
            return;
          }
          void queue
            .enqueueUnique({
              // Dedupe on the logical operation: a re-tap replaces the
              // queued payload instead of stacking duplicates.
              dedupeKey: `outcome:${openVisit.id}:${outcome}`,
              endpoint: `/visits/${openVisit.id}/outcome`,
              method: 'PATCH',
              body,
            })
            .then(() => toast.success('Saved locally - will sync when online'));
        },
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
              The lead is ready for a site visit - pick a date/time and
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
              {/*
                T-VISIT-OUTCOME-GATE (2026-09-16 owner ruling): each button is
                gated per-outcome by `canLogVisitOutcome`, not by the
                panel-level `canScheduleVisits`. The old gate included
                TELECALLER, so a telecaller was offered "Mark completed" - which
                the server refuses (403: only the exec/manager/admin conduct a
                visit, and COMPLETED is what drives the lead to VISITED). The
                helper already encoded the ruling; it was simply never called.
              */}
              {canLogVisitOutcome(user?.role, 'COMPLETED') ? (
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
              ) : null}
              {canLogVisitOutcome(user?.role, 'NO_SHOW') ? (
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
              ) : null}
              {canLogVisitOutcome(user?.role, 'CANCELLED') ? (
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
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
