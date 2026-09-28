'use client';

// Admin/owner command center - DAILY PROBLEM INBOX (2026-09-17). Supersedes
// the KPI + charts overview per the owner's correction: "I don't want existing
// cards and charts, i want something new ... to find out problems and resolve
// issues, when leads is not calling so long time and so on."
//
// THE JOB: one daily screen that says "these are the problems, in order, here
// is the fix" across every project and team. Charts are gone. Instead this
// renders four "problem class" cards, each from GET /api/dashboard/exceptions:
//   1. Leads not called   (the flagship: real idle leads, sorted oldest first)
//   2. Visits at risk     (open visits whose slot is today or past)
//   3. Booking money not moving  (token paid awaiting approval, or no token)
//   4. Team / exec health (staff gone quiet, or overloaded)
//
// Each row carries a projectId; the page resolves it → slug via the useProjects()
// registry so deep-links work cross-project. Every number is server-computed; an
// empty card means "all clear", which is a real signal, not a broken counter.
//
// ADMIN/OWNER only - the route's commandCenterRedirectTarget already sends
// non-admins to their project dashboard, and the API enforces the guard.
//
// LOW-1: the redirect below is a UX mirror, NOT a security boundary. The real
// data boundary is RLS + the service guard. Do not "harden" this by removing
// RLS reliance - the server is the wall.

import { Badge, Button, Heading, TypographyP } from '@paalstack/react-ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Skeleton } from '@/components/shared/Skeleton';
import { useDashboardExceptions } from '@/hooks/queries/dashboard';
import { useProjects } from '@/hooks/queries';
import { orgHref, projectHref } from '@/lib/nav';
import { useSessionUser } from '@/lib/session';
import { useOrgSlug } from '@/lib/tenant-context';
import { commandCenterRedirectTarget } from '@/lib/dashboard-redirect';

export default function AdminDashboardPage() {
  const orgSlug = useOrgSlug();
  const { user, isPending: sessionPending } = useSessionUser();
  const { data: projects } = useProjects();
  const [mounted, setMounted] = useState(false);

  // Better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending=true during SSR. Without this gate the
  // server HTML shows the skeleton while hydration swaps it for the real
  // dashboard → "Hydration failed because the server rendered HTML didn't
  // match the client." Render the skeleton for the first client paint too,
  // then swap after mount (same pattern as app-header.tsx).
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending) return <Skeleton variant="overview" className="py-4" />;
  if (user === null) {
    return (
      <div className="py-24 text-center text-sm">
        Session expired.{' '}
        <Link href="/login" className="underline">
          Sign in again
        </Link>
        .
      </div>
    );
  }
  // Design fix M1: redirect non-admins to the project work dashboard (no
  // dead-end). Guard the empty-registry loop (eng CRITICAL-2): if no
  // default project, go to /projects - otherwise projectHref(null, ...)
  // returns /overview and the redirect loops forever.
  const redirectTarget = commandCenterRedirectTarget(
    user.role,
    projects ?? [],
    orgSlug,
  );
  if (redirectTarget !== null) {
    return <RedirectToProject href={redirectTarget} />;
  }
  return <ProblemInbox />;
}

/** Redirect a non-admin away from /overview. */
function RedirectToProject({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(href);
  }, [href, router]);
  return <Skeleton variant="user" className="py-24" />;
}

// ---------------------------------------------------------------------------
// The problem inbox - one page, four problem cards, count-as-filter, rows link
// to the fix. (2026-09-17, supersedes the KPI/charts command center.)
// ---------------------------------------------------------------------------

function ProblemInbox() {
  const orgSlug = useOrgSlug();
  const exceptionsQuery = useDashboardExceptions();
  const { data: projects } = useProjects();

  // Cross-project deep-links: projectId → { slug, name } from the registry.
  const projectsById = useMemo(() => {
    const map = new Map<string, { slug: string; name: string }>();
    for (const p of projects ?? []) map.set(p.id, { slug: p.slug, name: p.name });
    return map;
  }, [projects]);

  const exceptions = exceptionsQuery.data;

  if (exceptionsQuery.isLoading) {
    return <Skeleton variant="overview" aria-label="Loading the problem inbox" />;
  }

  const err = exceptionsQuery.error;
  if (err !== null && err !== undefined) {
    return (
      <div className="space-y-6">
        <ProblemHeader />
        <div
          role="alert"
          className="border-destructive/50 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm"
        >
          <p className="font-semibold">Could not load the problem inbox</p>
          <p className="mt-1 opacity-90">
            {err instanceof Error ? err.message : 'Please try again.'}
          </p>
        </div>
      </div>
    );
  }

  const idleLeads = exceptions?.idleLeads ?? [];
  const visitRisk = exceptions?.visitRisk ?? [];
  const bookingMoney = exceptions?.bookingMoney ?? [];
  const teamHealth = exceptions?.teamHealth ?? [];

  const projectLabel = (projectId: string): string =>
    projectsById.get(projectId)?.name ?? 'Unknown project';

  return (
    <div className="space-y-8">
      <ProblemHeader />

      {/* Card 1 - the flagship: leads nobody has touched in a day.
          T-STATUS-ONE-TRUTH (2026-09-28): titled "Going stale", NOT "Leads not
          called". The server window reads Lead.updatedAt, which bumps on any
          write, so this cannot claim to know about calls - the Activity table
          that would carry a real call timestamp is still unwritten by
          production code. The old title promised data that does not exist, and
          the leads page's "overdue" (a 30-minute first-touch SLA) is a
          different question again, so the card states its own threshold and
          scope instead of inviting the comparison. */}
      <ProblemCard
        title="Going stale"
        count={idleLeads.length}
        empty="All active leads were touched in the last day. All clear."
        sub="no write in 24h+ · oldest first · all projects"
      >
        <ul role="list" className="divide-border divide-y">
          {idleLeads.slice(0, 10).map((lead) => {
            const href = leadHref(orgSlug, lead.projectId, lead.id, projectsById);
            return (
              <li
                key={lead.id}
                className="flex flex-col gap-y-1 py-2.5 text-sm sm:flex-row sm:items-center sm:gap-x-4"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{lead.name}</span>
                  <span className="text-muted-foreground mt-0.5 block text-sm truncate">
                    {projectLabel(lead.projectId)}
                    {lead.ownerName ? ` · ${lead.ownerName}` : ''}
                  </span>
                </span>
                <span className="flex items-center justify-between gap-3 sm:justify-start">
                  <span className="text-muted-foreground text-sm tabular-nums">
                  {lead.idleDays}d since last write
                </span>
                  {href !== null ? (
                    <Button
                      as={Link}
                      variant="link"
                      size="sm"
                      href={href}
                      className="text-link p-2.5 sm:p-0"
                    >
                      Open
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </ProblemCard>

      {/* Card 2 - visits that slipped. */}
      <ProblemCard
        title="Visits at risk"
        count={visitRisk.length}
        empty="No open visits have past their slot today. All clear."
        sub="overdue first"
      >
        <ul role="list" className="divide-border divide-y">
          {visitRisk.slice(0, 10).map((visit) => {
            const href = leadHref(orgSlug, visit.projectId, visit.leadId, projectsById);
            return (
              <li
                key={visit.id}
                className="flex flex-col gap-y-1 py-2.5 text-sm sm:flex-row sm:items-center sm:gap-x-4"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{visit.leadName}</span>
                  <span className="text-muted-foreground mt-0.5 block text-sm truncate">
                    {projectLabel(visit.projectId)}
                    {visit.userName ? ` · ${visit.userName}` : ' · no exec assigned'}
                  </span>
                </span>
                <span className="flex items-center justify-between gap-3 sm:justify-start">
                  <span className="text-muted-foreground text-sm">
                    {visit.reason === 'overdue-past-due' ? 'past due' : 'scheduled today'}
                  </span>
                  {href !== null ? (
                    <Button
                      as={Link}
                      variant="link"
                      size="sm"
                      href={href}
                      className="text-link p-2.5 sm:p-0"
                    >
                      Open
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </ProblemCard>

      {/* Card 3 - money not moving. */}
      <ProblemCard
        title="Booking money"
        count={bookingMoney.length}
        empty="No booking is held on money. All clear."
        sub="oldest stuck first"
      >
        <ul role="list" className="divide-border divide-y">
          {bookingMoney.slice(0, 10).map((booking) => {
            const proj = projectsById.get(booking.projectId);
            const href = proj
              ? projectHref(orgSlug, proj.slug, `/bookings/${booking.id}`)
              : null;
            return (
            <li
              key={booking.id}
              className="flex flex-col gap-y-1 py-2.5 text-sm sm:flex-row sm:items-center sm:gap-x-4"
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">{booking.leadName}</span>
                <span className="text-muted-foreground mt-0.5 block text-sm truncate">
                  {booking.unitNumber ? `Unit ${booking.unitNumber} · ` : ''}
                  {projectLabel(booking.projectId)}
                </span>
              </span>
              <span className="flex items-center justify-between gap-3 sm:justify-start">
                {booking.reason === 'token-paid-awaiting-approval' ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="success" data-qa={`booking-token-paid-${booking.id}`}>
                      Token paid
                    </Badge>
                    <Badge variant="warning" data-qa={`booking-approval-due-${booking.id}`}>
                      {booking.stuckDays}d to approve
                    </Badge>
                  </span>
                ) : (
                  <span className="text-muted-foreground text-sm">
                    {booking.stuckDays}d no token
                  </span>
                )}
                {href !== null ? (
                  <Button as={Link} variant="link" size="sm" href={href} className="text-link p-2.5 sm:p-0">
                    Approve
                  </Button>
                ) : null}
              </span>
            </li>
            );
          })}
        </ul>
      </ProblemCard>

      {/* Card 4 - the systemic one: staff went quiet or are overloaded. */}
      <ProblemCard
        title="Team / exec health"
        count={teamHealth.length}
        empty="Every staff member touched a lead in the last day. All clear."
        sub="quiet staff first"
      >
        <ul role="list" className="divide-border divide-y">
          {teamHealth.slice(0, 10).map((member) => {
            const href = member.userId
              ? orgHref(orgSlug, `/admin/users/${member.userId}`)
              : null;
            return (
            <li
              key={member.userId}
              className="flex flex-col gap-y-1 py-2.5 text-sm sm:flex-row sm:items-center sm:gap-x-4"
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">{member.userName}</span>
                <span className="text-muted-foreground mt-0.5 block text-sm">
                  {member.role.toLowerCase().replace('_', ' ')}
                </span>
              </span>
              <span className="flex items-center justify-between gap-3 sm:justify-start">
                <span className="text-muted-foreground text-sm">
                  {member.kind === 'quiet'
                    ? `quiet ${member.quietDays}d · ${member.activeLeadCount} leads`
                    : `overloaded · ${member.activeLeadCount} active leads`}
                </span>
                {href !== null ? (
                  <Button as={Link} variant="link" size="sm" href={href} className="text-link p-2.5 sm:p-0">
                    Review
                  </Button>
                ) : null}
              </span>
            </li>
            );
          })}
        </ul>
      </ProblemCard>
    </div>
  );
}

function ProblemHeader() {
  return (
    <div>
      {/* H2 naming fix: "Overview" matches the nav label - one name. */}
      <Heading className="mb-1">Overview</Heading>
      <TypographyP className="text-muted-foreground text-sm">
        The problems that need a decision today, across every team and project.
      </TypographyP>
    </div>
  );
}

/** Deep-link a row to its own project's lead page; null if that project is unresolved. */
function leadHref(
  orgSlug: string | null,
  projectId: string,
  leadId: string,
  projectsById: Map<string, { slug: string; name: string }>,
): string | null {
  const proj = projectsById.get(projectId);
  if (!proj) return null;
  return projectHref(orgSlug, proj.slug, `/leads/${leadId}`);
}

function ProblemCard({
  title,
  count,
  empty,
  sub,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center justify-between sm:mb-3">
        <h2 className="text-sm font-semibold tracking-wide uppercase">{title}</h2>
        <span className="text-muted-foreground text-sm tabular-nums">
          {count} {count === 1 ? 'problem' : 'problems'} · {sub}
        </span>
      </div>
      <div className="border-border rounded-lg border p-3 sm:p-4">
        {count === 0 ? (
          <p className="text-muted-foreground text-sm">{empty}</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
