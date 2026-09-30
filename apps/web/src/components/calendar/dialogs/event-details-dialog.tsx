'use client';

// EventDetailsDialog - the visit detail view opened from a calendar event.
//
// ORIGINAL (adapted from lramos33/big-calendar): a READ-ONLY panel showing
// responsible / start / end / description. It answered "when is this?" and
// nothing else. Owner feedback, 2026-09-29:
//
//   "when we open dialog, there is no way to staff see whether visited was
//    happened or not and give link of leads and give option to reschedule"
//
// So the dialog now answers three questions it could not before:
//   1. DID IT HAPPEN?  - a status chip in the same colours as the calendar
//      (green happened / red did not / yellow rescheduled), plus the recorded
//      outcome and notes.
//   2. WHICH LEAD?     - a real link to the lead detail page, not just a name.
//   3. WHAT CAN I DO?  - outcome + reschedule actions, role-gated.
//
// WHY THE ACTIONS ARE NOT A SECOND IMPLEMENTATION. `LeadVisitPanel` already
// records visit outcomes on the lead page, including a per-outcome role gate
// (`canLogVisitOutcome`) and an offline-queue branch. Rather than write a
// parallel version here, this dialog reuses the SAME hook and the SAME gate.
// Two code paths that must independently agree about permissions is exactly how
// a UI ends up offering a button the server refuses.
//
// WHAT IS DELIBERATELY NOT HERE: an outcome/reschedule control the status does
// not permit. `visits.service.reschedule` accepts only SCHEDULED or NO_SHOW, and
// an outcome is only recorded while the visit is open - so the action row is
// DERIVED from those rules rather than being a fixed button list. A COMPLETED
// visit shows no actions at all, which is the honest answer.
import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import Link from 'next/link';

import {
  LuCalendar,
  LuCalendarClock,
  LuCircleCheck,
  LuCircleX,
  LuClipboardCheck,
  LuExternalLink,
  LuText,
  LuTriangleAlert,
  LuUser,
} from '@paalstack/react-icons/lu';
import { Button, Dialog, toast } from '@paalstack/react-ui';

import { RescheduleVisitDialog } from '@/components/shared/RescheduleVisitDialog';
import { useUpdateVisitOutcome } from '@/hooks/queries/crm';
import { labelFor } from '@/lib/labels';
import { projectHref } from '@/lib/nav';
import { canLogVisitOutcome, useSessionUser } from '@/lib/session';
import { useOrgSlug, useProjectSlug } from '@/lib/tenant-context';
import { visitStatusColor } from '@/lib/visit-status';

import type { IEvent } from '../interfaces';

interface IProps {
  event: IEvent;
  children: React.ReactNode;
}

/**
 * The status chip's surface, keyed by the same colour the calendar uses, so the
 * dialog and the card can never disagree about what green means.
 *
 * The chip ALWAYS carries the friendly status text as well as the colour - WCAG
 * 1.4.1, never colour alone. A red border with no words tells a colour-blind
 * user nothing, which is why this is a labelled chip rather than a tinted edge.
 *
 * The tokens are the same soft/soft-fg pairs LeadStatusBadge uses and that the
 * badge contrast test already audits to >= 4.5:1.
 */
const STATUS_CHIP: Record<string, string> = {
  green: 'bg-success-soft text-success-soft-fg border-success/30',
  red: 'bg-destructive-soft text-destructive-soft-fg border-destructive/30',
  yellow: 'bg-warning-soft text-warning-foreground border-warning/30',
  blue: 'bg-info-soft text-info-soft-fg border-info/30',
  gray: 'bg-muted text-foreground border-border',
  // Not reachable from a real status (see VISIT_STATUS_COLOR); kept so an
  // unexpected tone degrades to neutral instead of rendering with no styles.
  purple: 'bg-muted text-foreground border-border',
  orange: 'bg-muted text-foreground border-border',
};

/** The icon that matches the tone - a second, non-colour cue for the state. */
function StatusIcon({ tone }: { tone: string }) {
  if (tone === 'green') return <LuCircleCheck className="size-3.5 shrink-0" aria-hidden="true" />;
  if (tone === 'red') return <LuCircleX className="size-3.5 shrink-0" aria-hidden="true" />;
  if (tone === 'yellow') return <LuTriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />;
  return <LuCalendarClock className="size-3.5 shrink-0" aria-hidden="true" />;
}

export function EventDetailsDialog({ event, children }: IProps) {
  const { user } = useSessionUser();
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();
  const [rescheduleOpen, setRescheduleOpen] = useState(false);

  const startDate = parseISO(event.startDate);
  const endDate = parseISO(event.endDate);

  const visit = event.visit;
  const status = visit?.status ?? '';
  const outcome = visit?.outcome ?? null;
  // The OUTCOME is what happened on site; the LEAD STATE is where the deal now
  // stands. The lead page shows the lead state (LeadStatusBadge), so that is what
  // this chip must show too - otherwise the same event reads "Done" here and
  // "Visited" there (owner requirement, 2026-09-29).
  const leadState = visit?.leadState ?? '';
  const tone = visitStatusColor(status, outcome);

  const chipLabel = leadState.length > 0 ? labelFor('lead', leadState) : '';
  const chipClass = STATUS_CHIP[tone] ?? STATUS_CHIP['gray'] ?? '';

  const updateOutcome = useUpdateVisitOutcome(visit !== undefined ? event.id : null);
  const isPending = updateOutcome.isPending;

  // The lead link needs the project slug; without it there is no route, so the
  // name renders as plain text rather than a dead link.
  const leadHref =
    visit !== undefined && projectSlug !== null
      ? projectHref(orgSlug, projectSlug, `/leads/${visit.leadId}`)
      : null;

  // Derived from the service's own rules, not a hard-coded list.
  const canRecordOutcome =
    visit !== undefined && (status === 'SCHEDULED' || status === 'RESCHEDULED');
  const canReschedule = visit !== undefined && (status === 'SCHEDULED' || status === 'NO_SHOW');

  const anyAction = visit !== undefined && (canRecordOutcome || canReschedule);
  const canComplete = canRecordOutcome && canLogVisitOutcome(user?.role, 'COMPLETED');

  function recordOutcome(next: 'COMPLETED' | 'NO_SHOW' | 'CANCELLED') {
    updateOutcome.mutate(
      { visitId: event.id, outcome: next, notes: '' },
      {
        onSuccess: () => toast.success(`Visit marked ${labelFor('visit', next).toLowerCase()}`),
        onError: (e) => {
          // No offline queue here, unlike LeadVisitPanel: this dialog is opened
          // from a calendar the user had to load online, and silently queueing a
          // write the user believes landed is worse than telling them it failed.
          toast.error(e instanceof Error ? e.message : 'Could not record the outcome');
        },
      },
    );
  }

  return (
    <>
      <Dialog
        trigger={children}
        contentClassName="sm:max-w-lg"
        header={{
          title: event.title,
          description: (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${chipClass}`}
              data-qa="visit-status-chip"
            >
              <StatusIcon tone={tone} />
              {/* The words carry the state; the colour only reinforces it. Shows
                  the LEAD's pipeline state, matching the lead page's badge. */}
              {visit === undefined
                ? 'No visit details'
                : chipLabel.length > 0
                  ? chipLabel
                  : labelFor('visit', status)}
            </span>
          ),
        }}
        footer={<span className="text-muted-foreground text-xs">Conducted by {event.user.name}</span>}
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2">
            <LuUser className="mt-1 size-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium">Lead</p>
              {leadHref !== null ? (
                <Link
                  href={leadHref}
                  className="text-link focus-visible:ring-ring inline-flex items-center gap-1 rounded-sm text-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
                  data-qa="visit-lead-link"
                >
                  {event.title}
                  <LuExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                </Link>
              ) : (
                <p className="text-muted-foreground text-sm">{event.title}</p>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2">
            <LuCalendar className="mt-1 size-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium">Scheduled for</p>
              <p className="text-muted-foreground text-sm">
                {format(startDate, 'MMM d, yyyy h:mm a')} - {format(endDate, 'h:mm a')}
              </p>
            </div>
          </div>

          {outcome !== null && outcome.length > 0 ? (
            <div className="flex items-start gap-2">
              <LuClipboardCheck className="mt-1 size-4 shrink-0" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium">What happened on site</p>
                {/* The visit's own OUTCOME - deliberately distinct from the
                    lead's pipeline state shown in the chip above. The chip says
                    where the deal stands; this says what was recorded. */}
                <p className="text-muted-foreground text-sm">
                  {labelFor('visit', outcome)}
                </p>
              </div>
            </div>
          ) : null}

          {event.description.length > 0 ? (
            <div className="flex items-start gap-2">
              <LuText className="mt-1 size-4 shrink-0" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium">Notes</p>
                <p className="text-muted-foreground text-sm">{event.description}</p>
              </div>
            </div>
          ) : null}

          {anyAction ? (
            <div className="border-border space-y-2 border-t pt-4">
              <p className="text-sm font-medium">Record what happened</p>
              <div className="flex flex-wrap gap-2">
                {canComplete ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    onClick={() => recordOutcome('COMPLETED')}
                    disabled={isPending}
                    data-qa="visit-dialog-completed"
                  >
                    Visit happened
                  </Button>
                ) : null}
                {canRecordOutcome && canLogVisitOutcome(user?.role, 'NO_SHOW') ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => recordOutcome('NO_SHOW')}
                    disabled={isPending}
                    data-qa="visit-dialog-no-show"
                  >
                    Didn&apos;t happen
                  </Button>
                ) : null}
                {canRecordOutcome && canLogVisitOutcome(user?.role, 'CANCELLED') ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => recordOutcome('CANCELLED')}
                    disabled={isPending}
                    data-qa="visit-dialog-cancelled"
                  >
                    Cancel visit
                  </Button>
                ) : null}
                {canReschedule ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setRescheduleOpen(true)}
                    data-qa="visit-dialog-reschedule"
                  >
                    Reschedule
                  </Button>
                ) : null}
              </div>
              {canRecordOutcome && !canComplete ? (
                // Say WHY the actions are thin rather than leaving a user to
                // wonder where the button went. Mirrors LeadVisitPanel's ruling:
                // the telecaller drives re-outreach, the exec conducts the visit.
                <p className="text-muted-foreground text-xs">
                  Your role can mark this as a no-show. A manager records the visit itself.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </Dialog>

      {visit !== undefined ? (
        <RescheduleVisitDialog
          open={rescheduleOpen}
          onOpenChange={setRescheduleOpen}
          visitId={event.id}
          leadName={event.title}
          currentScheduledFor={event.startDate}
        />
      ) : null}
    </>
  );
}
