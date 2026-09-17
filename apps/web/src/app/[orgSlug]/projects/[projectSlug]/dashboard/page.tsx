'use client';

// Project work dashboard - the one-page work queue (T-DASH-QUEUE, 2026-09-16).
//
// WHAT CHANGED AND WHY. This page used to be a read-only metrics page: a KPI
// strip, six charts on the manager branch, one status list on the staff branch,
// and a bookings-on-hold table. It showed numbers ABOUT work and could not do
// any. Every action lived on another page, so a telecaller with a 30-minute
// first-touch deadline had to leave the screen to do the thing the screen was
// telling them to do. Charts are gone (owner instruction) and replaced with a
// queue whose rows carry their own next action.
//
// WHY A QUEUE AND NOT A DASHBOARD: this client's staff run their pipeline in
// Excel plus WhatsApp on personal phones and treat the CRM as data entry. The
// page's competitor is a habit, not another CRM, and a display-only page loses
// that comparison. So the page's job is to BE the work.
//
// ONE ROUTE, THREE ROLES. The route and layout are identical for everyone; role
// decides the queue contents, the counts, and which action a row may offer.
// Telecaller is the hero (they own the only hard deadline in the system); the
// exec gets today's visits to conduct plus their own pipeline; the manager gets
// the team queue and the booking approvals.
//
// ORDERING IS THE MECHANISM for keeping one screen usable, instead of hiding
// things behind clicks. The order lives in `lib/work-queue.ts` on purpose - one
// file to tune after the owner's observation run.
//
// DELIBERATELY ABSENT: a chat pane. Inbound customer WhatsApp messages reach the
// CRM while replies composed in the CRM never leave it (`useSendMessage` sends
// channel IN_APP, which the backend never enqueues), so the pane is a reply box
// that appears to work and does not. Putting that on the surface we are asking
// staff to live in would turn a dormant bug into active distrust. The expansion
// links to the lead's own page instead. Fixing send is a recorded upgrade
// trigger, not part of this change.
//
// ALSO ABSENT: a "today's pending tasks" / reminders panel. Nothing in the
// codebase creates or delivers a Reminder row (`deliverReminder` is a no-op stub
// and no service creates rows), so that list would be a heading with no data
// behind it. It ships when the backend does.
//
// PRESERVED FROM THE OLD PAGE: the mounted/sessionPending hydration gate, the
// shape-matched skeleton, the error banner, and the honest-numbers rule (real
// 0s, never a fabricated value).

import { Button, TypographyP, toast } from '@paalstack/react-ui';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import {
  BookingApprovalDialog,
  type BookingApprovalTarget,
} from '@/components/bookings/BookingApprovalDialog';
import { KpiStrip, SectionCard } from '@/components/dashboard/dashboard-shared';
import { TodayVisitsCard } from '@/components/dashboard/TodayVisitsCard';
import { LeadQueueRow, type QueueAction } from '@/components/dashboard/LeadQueueRow';
import { PendingApprovalsCard } from '@/components/dashboard/PendingApprovalsCard';
import { PendingTokenCard } from '@/components/dashboard/PendingTokenCard';
import { LeadVisitPanel } from '@/components/shared/LeadVisitPanel';
import { PageHeader } from '@/components/shared/PageHeader';
import { PhoneNumber } from '@/components/shared/PhoneNumber';
import { ScheduleVisitDialog } from '@/components/shared/ScheduleVisitDialog';
import { Skeleton } from '@/components/shared/Skeleton';
import {
  useBookings,
  useLeads,
  useLeadsEnvelope,
  useTransitionLead,
  useUpdateBooking,
  useVisits,
} from '@/hooks/queries/crm';
import { useDashboardStats } from '@/hooks/queries/dashboard';
import { dateIntl } from '@/lib/format';
import { labelFor } from '@/lib/labels';
import { projectHref } from '@/lib/nav';
import { canApproveBookings, canInitiateBookings, useSessionUser } from '@/lib/session';
import { QUEUE_STATES_BY_ROLE, queueActionsFor } from '@/lib/queue-actions';
import { useOrgSlug, useProjectId, useProjectSlug } from '@/lib/tenant-context';
import { orderQueue } from '@/lib/work-queue';

type Role = 'TELECALLER' | 'SALES_EXEC' | 'MANAGER' | 'ADMIN' | 'OWNER';

/**
 * The fields this page reads off a lead list row. `useLeads` unwraps the
 * `{ total, rows }` envelope, so each element is a row. Declared explicitly
 * because the hook is typed `unknown` (it serves several endpoints), and a
 * blanket cast would silently drop `ownerName`/`phone` from the render.
 */
type LeadListRow = {
  id: string;
  name?: string;
  phone?: string;
  status?: string;
  createdAt?: string;
  ownerName?: string;
};

// The per-role lane lives in `@/lib/queue-actions` (QUEUE_STATES_BY_ROLE) so
// the states shown and the actions offered cannot drift apart.

export default function DashboardPage() {
  const { user, isPending: sessionPending } = useSessionUser();
  const [mounted, setMounted] = useState(false);

  // Better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending=true during SSR. Without this gate the server
  // HTML shows the skeleton while hydration swaps it for the real dashboard,
  // producing "Hydration failed because the server rendered HTML didn't match
  // the client". Render the skeleton for the first client paint too, then swap
  // after mount (same pattern as app-header.tsx).
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending) {
    return <Skeleton variant="overview" className="py-4" />;
  }

  if (user === null) {
    return (
      <div className="py-24 text-center text-sm">
        Session expired.{' '}
        {/* variant="link" supplies the hover underline, so there is no manual
 `underline` to drift from it. */}
        <Button as={Link} variant="link" href="/login" className="text-link">
          Sign in again
        </Button>
        .
      </div>
    );
  }

  return <WorkQueue role={user.role as Role} userName={user.name ?? ''} />;
}

// ---------------------------------------------------------------------------
// The one page. Role decides contents, not the route.
// ---------------------------------------------------------------------------

function WorkQueue({ role, userName }: { role: Role; userName: string }) {
  const projectId = useProjectId();
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();

  const isTelecaller = role === 'TELECALLER';
  const isExec = role === 'SALES_EXEC';

  // Every role gets an explicit lane now, INCLUDING manager/admin/owner. It used
  // to pass no filter at all, so a manager's queue was every lead in scope - of
  // which the majority were VISITED, a state only the assigned exec can move.
  // A queue shows work; terminal states (WON/LOST/COLD) are archive and are in
  // no lane (T-DASH-QUEUE-SCOPE, owner decision 2026-09-16).
  const queueStates = useMemo(() => {
    if (isTelecaller) return QUEUE_STATES_BY_ROLE.TELECALLER;
    if (isExec) return QUEUE_STATES_BY_ROLE.SALES_EXEC;
    return QUEUE_STATES_BY_ROLE.MANAGER;
  }, [isTelecaller, isExec]);

  // Sort is pinned to createdAt ASC so the ORDERING MODULE - not the server -
  // decides urgency. Decision 3 in the design doc records why: the server sort
  // has buckets only for overdue-NEW / NEW / everything-else and accepts no
  // visit-state bucket, so the client refinement is applied to the LOADED PAGE.
  // That limit is named rather than pretended away.
  const leadsFilter = useMemo(
    () => ({
      // Spread because the lane is a `readonly` tuple (it is shared with the
      // pure action matrix and must not be mutated by a caller).
      state: queueStates.length > 0 ? [...queueStates] : undefined,
      limit: 100,
      projectId: projectId ?? undefined,
      sortBy: 'createdAt' as const,
      sortDir: 'asc' as const,
    }),
    [queueStates, projectId]
  );

  const leadsQuery = useLeads(leadsFilter);
  // The SAME filter, so this hits the same react-query cache entry (the key is
  // `['leads', filter]`). It exists only to read the server's real `total`.
  // `ordered.length` is the LOADED PAGE (limit 100), so using it as a count
  // would under-report - and silently, since the number looks plausible.
  const leadsEnvelope = useLeadsEnvelope(leadsFilter);

  const statsQuery = useDashboardStats(projectId ?? undefined);
  const stats = statsQuery.data;

  // Today's visits. VisitFilterDto requires `datetime({ offset: true })`, so
  // these are ISO strings - the same shape the visits page sends.
  const today = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { from: start.toISOString(), to: end.toISOString() };
  }, []);
  const visitsQuery = useVisits({
    from: today.from,
    to: today.to,
    projectId: projectId ?? undefined,
  });

  // Approvals are a manager/admin job - canApproveBookings mirrors the server.
  const showApprovals = canApproveBookings(role);
  // T-APPROVE-WRONG-STATE (2026-09-16, found while verifying the owner's
  // one-control report): this card asked for HOLD, but the dialog it opens
  // performs TOKEN → APPROVED | REJECTED, and `legalNextStates('HOLD')` is
  // ['TOKEN','CANCELLED']. So every row the card listed was UNDECIDABLE:
  // PATCH /bookings/:id {toStatus:'APPROVED'} on a HOLD row ->
  // 400 "Cannot transition booking from HOLD to APPROVED (allowed: TOKEN, CANCELLED)"
  // The manager saw "Awaiting approval", clicked Review, clicked Approve, and got
  // an error - a dead-end the server was always going to refuse. Verified live:
  // the same call on a TOKEN row returns 200.
  //
  // A HOLD booking needs its token payment first (HOLD → TOKEN); it is not
  // waiting on a manager. Only TOKEN is "manager approval pending".
  const bookingsQuery = useBookings({
    status: ['TOKEN'],
    projectId: projectId ?? undefined,
  });

  // T-HOLD-VISIBLE (2026-09-16): HOLD bookings need their token payment
  // recorded. This is a DIFFERENT action from approval, with a WIDER role gate
  // (SALES_EXEC can record a token but can never approve), so it is its own card
  // rather than more rows in "Awaiting approval".
  //
  // Removing HOLD from the approvals card is what made this necessary: without
  // it, a booking sitting on HOLD with money outstanding appeared nowhere on the
  // dashboard.
  const showTokenQueue = canInitiateBookings(role);
  const tokenQuery = useBookings({
    status: ['HOLD'],
    projectId: projectId ?? undefined,
  });
  const updateBooking = useUpdateBooking();
  // WHICH booking is mid-flight, so only that row's button shows a spinner
  // instead of every button in the card.
  const [busyBookingId, setBusyBookingId] = useState<string | null>(null);

  const [approvalTarget, setApprovalTarget] = useState<BookingApprovalTarget | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // WHICH lead the dialog is scheduling - and, because that is the only reason
  // the dialog is ever open, ALSO whether it is open. Deliberately ONE piece of
  // state: an earlier version had a separate `visitDialogOpen` boolean plus this
  // id, and the row's Schedule-visit action set only the id, so the dialog never
  // opened and the button looked dead. One value cannot drift from itself.
  const [scheduleLeadId, setScheduleLeadId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'overdue' | 'visits'>('all');

  const rows = Array.isArray(leadsQuery.data) ? leadsQuery.data : [];
  const ordered = useMemo(() => orderQueue(rows as LeadListRow[]), [rows]);
  // The count card must show the SERVER's total, not `ordered.length` - the
  // latter is the loaded page (limit 100), so it under-reports once a lane
  // exceeds one page, and it does so silently because the number looks
  // plausible. Declared here, AFTER `ordered`, so the fallback can't trip a
  // temporal-dead-zone error.
  const queueTotal = leadsEnvelope?.total ?? ordered.length;
  const visits = Array.isArray(visitsQuery.data) ? visitsQuery.data : [];

  const overdueCount = stats?.kpis.overdueLeads ?? 0;
  const newToday = stats?.kpis.newLeadsToday ?? 0;
  const visitsToday = stats?.kpis.visitsToday ?? 0;
  // NOTE: there is deliberately no "unassigned leads" counter here. One was added
  // (T-DASH-ORPHAN-EXPLAIN) to explain a zero when 141 leads belonged to no
  // project - but `Lead.projectId` is now NOT NULL (T-LEAD-PROJECT-REQUIRED), so
  // that state cannot exist. Kept as a note so the fallback is not reinvented.

  // The "needs a call now" filter narrows to NEW only, because the 30-minute
  // SLA governs NEW alone (lib/leads.ts is NEW-only by design and by test).
  const queueShown = filter === 'overdue' ? ordered.filter((row) => row.status === 'NEW') : ordered;

  return (
    // T-DASH-MOBILE: 16px between sections on phones, 24px from 30rem up. The
    // page stacks seven sections; 24px each is 144px of pure gap, and on a 568px
    // screen every one of those pixels is pushing the queue - the only thing the
    // page exists for - further down.
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Work"
        breadcrumb={[{ label: 'Work' }, { label: 'Today' }]}
        subtitle={
          isTelecaller
            ? 'Your queue. Work it top down - the most urgent call is always first.'
            : isExec
              ? 'Today\u2019s visits to conduct, then your own pipeline.'
              : `Your team\u2019s queue and anything awaiting approval${userName.length > 0 ? `, ${userName}` : ''}.`
        }
      />

      {/* Counts, not charts. Each count doubles as a filter, which is why
 KpiStrip gained an additive `onClick` (see dashboard-shared.tsx). */}
      {statsQuery.isLoading ? (
        <Skeleton variant="kpi" aria-label="Loading counts" />
      ) : (
        <KpiStrip
          items={[
            {
              label: isExec ? 'My pipeline' : 'Needs a call now',
              value: isExec ? String(ordered.length) : String(overdueCount),
              // A bare "0" reads as a broken counter, so a zero says WHY it is
              // zero. The "have no project" branch is gone with the constraint
              // that made it reachable - every lead belongs to a project now.
              sub: isExec
                ? 'in my name'
                : overdueCount === 0
                  ? 'none overdue'
                  : 'overdue first touch',
              onClick: () => setFilter((f) => (f === 'overdue' ? 'all' : 'overdue')),
              active: filter === 'overdue',
            },
            {
              label: 'New today',
              value: String(newToday),
              sub: 'created in the last 24h',
            },
            {
              label: "Today's visits",
              value: String(visitsToday),
              sub: visits.length > 0 ? `${visits.length} listed below` : 'none scheduled',
              onClick: () => setFilter((f) => (f === 'visits' ? 'all' : 'visits')),
              active: filter === 'visits',
            },
            {
              label: isTelecaller ? 'In my queue' : 'Leads to work',
              // Server total, NOT `ordered.length` - see `queueTotal`.
              value: String(queueTotal),
              sub: 'need action',
            },
          ]}
        />
      )}

      {statsQuery.error !== null && statsQuery.error !== undefined ? (
        <div
          role="alert"
          className="border-destructive/50 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm"
        >
          <p className="font-semibold">Some counts unavailable</p>
          <p className="mt-1 opacity-90">
            {statsQuery.error instanceof Error
              ? statsQuery.error.message
              : 'Could not load the counts. The queue below is still live.'}
          </p>
        </div>
      ) : null}

      {/*
 T-DASH-KPI-COLUMN (2026-09-16): ORDERING is what keeps the primary work
 reachable now that the four counts stack into a column on a phone. The
 counts cost ~190px stacked, and on a 568px screen that pushed the first
 action to 562px - i.e. off the bottom.

 So whoever's JOB the visits are gets them first: for a sales exec the
 visits are the clock-driven work and the queue is their own pipeline
 second; for a telecaller the queue is the job and the visits are
 confirmation. This is only a change of ORDER - the same two sections, the
 same filters, the same role rules, and desktop reads the same because the
 page is a single column either way.
 */}
      {isExec && filter !== 'overdue' ? (
        <TodayVisitsCard
          visits={visits}
          isLoading={visitsQuery.isLoading}
          isExec={isExec}
          orgSlug={orgSlug}
          projectSlug={projectSlug}
        />
      ) : null}

      {/* THE QUEUE. Sorted by lib/work-queue.ts, which is the one file the
 observation run is expected to tune. */}
      {filter !== 'visits' ? (
        <SectionCard title={isTelecaller ? 'Call these now' : 'Queue'}>
          {leadsQuery.isLoading ? (
            <Skeleton variant="table" />
          ) : leadsQuery.error !== null && leadsQuery.error !== undefined ? (
            <div
              role="alert"
              className="border-destructive/50 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm"
            >
              <p className="font-semibold">Could not load your queue</p>
              <p className="mt-1 opacity-90">
                {leadsQuery.error instanceof Error ? leadsQuery.error.message : 'Please try again.'}
              </p>
            </div>
          ) : queueShown.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">
              Nothing needs a call right now.
            </p>
          ) : (
            <ul role="list" className="space-y-2" data-qa="work-queue">
              {queueShown.map((lead, index) => {
                const expanded = expandedId === lead.id;
                return (
                  <QueueItem
                    key={lead.id}
                    role={role}
                    lead={{
                      id: lead.id,
                      name: typeof lead.name === 'string' ? lead.name : '(no name)',
                      phone: lead.phone,
                      status: lead.status,
                      createdAt: lead.createdAt,
                      ownerName: lead.ownerName,
                    }}
                    position={index + 1}
                    isExpanded={expanded}
                    onToggle={() => setExpandedId(expanded ? null : lead.id)}
                    onSchedule={setScheduleLeadId}
                  />
                );
              })}
            </ul>
          )}
        </SectionCard>
      ) : null}

      {/* Visits, for everyone the queue comes first for (see the ordering note
 above the queue). */}
      {!isExec && filter !== 'overdue' ? (
        <TodayVisitsCard
          visits={visits}
          isLoading={visitsQuery.isLoading}
          isExec={isExec}
          orgSlug={orgSlug}
          projectSlug={projectSlug}
        />
      ) : null}

      {/* Approvals - manager/admin only, mirroring the server gate. */}
      {showApprovals ? (
        <PendingApprovalsCard
          bookings={Array.isArray(bookingsQuery.data) ? bookingsQuery.data : []}
          isLoading={bookingsQuery.isLoading}
          onReview={setApprovalTarget}
        />
      ) : null}

      {/* Token payments - a WIDER gate than approvals: SALES_EXEC may record a
 token but can never approve (T-HOLD-VISIBLE). */}
      {showTokenQueue ? (
        <PendingTokenCard
          bookings={Array.isArray(tokenQuery.data) ? tokenQuery.data : []}
          isLoading={tokenQuery.isLoading}
          busyBookingId={busyBookingId}
          onRecord={(booking) => {
            setBusyBookingId(booking.id);
            updateBooking.mutate(
              // TOKEN carries no `reason` requirement (TransitionReasonRequired
              // is CANCELLED/REJECTED only), so this is a single forward step -
              // which is why it needs no confirmation dialog.
              { id: booking.id, body: { toStatus: 'TOKEN' } },
              {
                onSuccess: () => {
                  const which =
                    booking.unitNumber === undefined
                      ? (booking.leadName ?? 'booking')
                      : `Unit ${booking.unitNumber}`;
                  toast.success(`Token recorded for ${which}`);
                  // The list is invalidated by the mutation itself; refetch the
                  // approvals card too, since the booking may now be waiting on
                  // a manager and should appear there without a page reload.
                  void bookingsQuery.refetch();
                },
                onError: (e: unknown) =>
                  toast.error(e instanceof Error ? e.message : 'Could not record the token'),
                onSettled: () => setBusyBookingId(null),
              }
            );
          }}
        />
      ) : null}

      <TypographyP className="sr-only">
        Signed in as {labelFor('role', role)}. {ordered.length} leads in the queue.
      </TypographyP>

      <BookingApprovalDialog
        booking={approvalTarget}
        open={approvalTarget !== null}
        onOpenChange={(open) => {
          if (!open) setApprovalTarget(null);
        }}
      />

      <ScheduleVisitDialog
        open={scheduleLeadId !== null}
        onOpenChange={(next) => {
          if (!next) setScheduleLeadId(null);
        }}
        initialLeadId={scheduleLeadId ?? undefined}
        hideLeadPicker={scheduleLeadId !== null}
        onCreated={() => {
          void visitsQuery.refetch();
          void leadsQuery.refetch();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row actions - a thin adapter over the PURE matrix in `@/lib/queue-actions`.
//
// The permission logic (which role may make which move) lives there, React-free,
// so `lib/queue-actions.test.ts` can pin the whole matrix in milliseconds
// without rendering a component. This function's only job is to attach the
// mutation and a toast to each spec.
//
// No optimistic UI: the state machine is authoritative, and a silently failed
// move would leave the row showing progress that never happened.
// ---------------------------------------------------------------------------

function buildRowActions({
  role,
  lead,
  transition,
  onSchedule,
}: {
  role: Role;
  lead: { id: string; name?: string; status?: string };
  transition: ReturnType<typeof useTransitionLead>;
  onSchedule: () => void;
}): QueueAction[] {
  const status = typeof lead.status === 'string' ? lead.status : '';
  const specs = queueActionsFor({ role, status });

  return specs.map((spec) => {
    if (spec.kind === 'scheduleVisit') {
      return { label: spec.label, dataQa: spec.dataQa, onClick: onSchedule };
    }
    return {
      label: spec.label,
      dataQa: spec.dataQa,
      busy: transition.isPending,
      onClick: () =>
        transition.mutate({ leadId: lead.id, toState: spec.to } as never, {
          onSuccess: () => toast.success(`Moved to ${labelFor('lead', spec.to)}`),
          onError: (e: unknown) =>
            toast.error(e instanceof Error ? e.message : 'Could not move this lead'),
        }),
    };
  });
}

// ---------------------------------------------------------------------------
// QueueItem - one queue row, owning its OWN transition mutation.
//
// WHY THIS IS A COMPONENT AND NOT AN INLINE render: the transition hook is a
// useMutation, i.e. a hook. Calling it inside the queue's `.map()` made the
// number of hooks depend on how many leads were in the list, so the moment the
// list length changed React's hook order broke ("Rendered more hooks than
// during the previous render"). A per-row component keeps the hook count fixed
// per row, which is what the rules of hooks require. tsc and eslint both pass
// on the broken version, so this is the kind of bug only this structure avoids.
// ---------------------------------------------------------------------------

function QueueItem({
  role,
  lead,
  position,
  isExpanded,
  onToggle,
  onSchedule,
}: {
  role: Role;
  lead: LeadListRow & { name: string };
  position: number;
  isExpanded: boolean;
  onToggle: () => void;
  onSchedule: (leadId: string) => void;
}) {
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();
  const transition = useTransitionLead(lead.id);

  return (
    <LeadQueueRow
      lead={{
        id: lead.id,
        name: lead.name,
        phone: lead.phone,
        status: lead.status,
        createdAt: lead.createdAt,
        ownerName: lead.ownerName,
      }}
      // T-DASH-MOBILE: dialling is THE telecaller action, and as inline text this
      // link is ~96x16px - a third of the 44px tap-target minimum in the one
      // dimension that matters. `largeTapTarget` enlarges it on a coarse pointer
      // and leaves the number visible and readable everywhere.
      phone={<PhoneNumber phone={lead.phone} showIcon className="text-xs" largeTapTarget />}
      position={position}
      isExpanded={isExpanded}
      onToggle={onToggle}
      actions={buildRowActions({
        role,
        lead,
        transition,
        onSchedule: () => onSchedule(lead.id),
      })}
      expanded={
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">Owner: {lead.ownerName ?? '-'}</span>
            <span className="text-muted-foreground">
              Created:{' '}
              {typeof lead.createdAt === 'string' ? dateIntl.formatDate(lead.createdAt) : '-'}
            </span>
            <Button
              as={Link}
              variant="link"
              href={projectHref(orgSlug, projectSlug, `/leads/${lead.id}`)}
              className="text-link"
            >
              Open the full lead page
            </Button>
          </div>
          {/* The visit panel carries schedule + outcome actions and is
 role-gated PER OUTCOME, so a telecaller never sees "Mark
 completed" (which the server refuses). */}
          <LeadVisitPanel lead={{ id: lead.id, status: lead.status }} />
        </div>
      }
    />
  );
}
