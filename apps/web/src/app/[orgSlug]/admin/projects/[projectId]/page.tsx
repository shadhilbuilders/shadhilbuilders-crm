'use client';

// /admin/projects/[projectId] - Admin/owner project A-Z detail page.
//
// Full per-project information surface (owner choice 2026-09-16):
//   - Identity card: name, slug, address, RERA, CMDA, created, Edit + staff +
//     delete actions (reuse the same bodies as the /admin/projects table).
//   - Count grid: phases / units / options / teams / members / leads / bookings
//     (from GET /api/projects/:id - the ProjectDetail endpoint).
//   - Per-project KPIs: from the existing GET /api/dashboard/stats?projectId=.
//   - Embedded sections: leads, inventory units, phases + option cards, and
//     the team/member roster.
//
// ADMIN/OWNER only (mirrors /admin/projects). The service guard is the wall;
// this is a UI mirror for fast feedback.
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

import { Button, Card, Dialog, Heading, TypographyP } from '@paalstack/react-ui';
import {
  LuAlarmClockOff,
  LuArrowLeft,
  LuBadgeIndianRupee,
  LuBuilding2,
  LuCalendarCheck,
  LuCompass,
  LuContactRound,
  LuLayers,
  LuPencil,
  LuTrash2,
  LuUserPlus,
  LuUserRound,
  LuUsersRound,
} from '@paalstack/react-icons/lu';
import type { IconType } from '@paalstack/react-icons';

import { Skeleton } from '@/components/shared/Skeleton';
import { PageHeader } from '@/components/shared/PageHeader';
import { PhasesSection } from '@/components/inventory/PhasesSection';
import { BhkOptionsCard, FacingOptionsCard } from '@/components/inventory/ProjectOptionsSection';
import { ProjectTeamList } from '@/components/teams/project-team-list';
import {
  ProjectDeleteBody,
  ProjectFormBody,
} from '@/components/projects/project-form-bodies';
import { useProjectDetail } from '@/hooks/queries';
import { useDashboardStats } from '@/hooks/queries/dashboard';
import { useInventoryPhases, useInventoryUnits, useProjectOptions } from '@/hooks/queries/inventory';
import { useLeads } from '@/hooks/queries/crm';
import { orgHref } from '@/lib/nav';
import { isAdminLike, useSessionUser } from '@/lib/session';
import { useOrgSlug } from '@/lib/tenant-context';
import { dateIntl } from '@/lib/format';

// ---------------------------------------------------------------------------
// KPI tiles (2026-09-29)
// ---------------------------------------------------------------------------
//
// Each tile is tinted by the SAME tone vocabulary the work dashboard's KpiStrip
// uses (dashboard-shared.tsx) and carries an icon. Two rules, both from the
// measured contrast work on that component:
//
//   1. The tone is semantic - red = needs action, blue = inventory/people
//      counts, amber = leads + money in flight, neutral = the structural totals.
//      It is NOT a per-card hue wheel. A 7-colour grid of equal-weight tiles is
//      the stock "AI dashboard" look and it destroys the scan order: everything
//      shouts, so nothing does.
//   2. `text-foreground` on the label/value, never `text-muted-foreground`:
//      muted (#64748b) is 4.75:1 on white but only 4.1-4.35:1 on these tints -
//      under the 4.5 AA floor. The muted token is only readable on a plain
//      white card.
//   3. The neutral tone is `secondary-soft`, NOT `primary-soft`: the library
//      declares `--primary-soft` identically in `:root` and `.dark`, so it stays
//      a light lavender in dark mode and `text-foreground` on it measures
//      1.42:1 - invisible. `secondary-soft` is a light tint in light mode and a
//      dark tint in dark mode (fg 16.2:1 / 8.5:1), so it needs no per-mode
//      handling. See the same note in dashboard-shared.tsx.
//
// The icon is `aria-hidden`: it repeats the label, so announcing it would make
// a screen reader read each tile twice. As on KpiStrip, the glyph is also the
// non-colour cue that keeps the tint WCAG 1.4.1-safe.
const KPI_TILE_TONES = {
  urgent: 'bg-destructive-soft border-destructive/25',
  inventory: 'bg-info-soft border-info/25',
  leads: 'bg-warning-soft border-warning/30',
  total: 'bg-secondary-soft border-border',
} as const;

type KpiTileTone = keyof typeof KPI_TILE_TONES;

function kpiCard(
  label: string,
  value: string,
  Icon: IconType,
  tone: KpiTileTone,
  iconTone: string,
  sub?: string,
) {
  return (
    <div className={`rounded-lg border p-4 ${KPI_TILE_TONES[tone]}`}>
      <span className="text-foreground flex items-center gap-2">
        <Icon className={`size-5 shrink-0 ${iconTone}`} aria-hidden="true" />
        <p className="text-xs font-medium tracking-wide uppercase">{label}</p>
      </span>
      <p className="text-foreground mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub ? <p className="text-foreground mt-0.5 text-xs">{sub}</p> : null}
    </div>
  );
}

export default function AdminProjectDetailPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = typeof params?.projectId === 'string' ? params.projectId : null;
  const orgSlug = useOrgSlug();
  const { user, isPending: sessionPending } = useSessionUser();
  const [mounted, setMounted] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);

  useEffect(() => setMounted(true), []);

  const detailQuery = useProjectDetail(projectId ?? undefined);
  const statsQuery = useDashboardStats(projectId ?? undefined);
  const leadsQuery = useLeads({ projectId: projectId ?? undefined, limit: 10 });
  const unitsQuery = useInventoryUnits({ projectId: projectId ?? undefined, limit: 10 });
  const phasesQuery = useInventoryPhases(projectId ?? undefined);
  const optionsQuery = useProjectOptions(projectId ?? undefined);

  const canManage = mounted && user !== null && isAdminLike(user.role);
  const detail = detailQuery.data;
  const stats = statsQuery.data;

  if (!mounted || sessionPending) {
    return <Skeleton variant="overview" className="py-4" />;
  }
  if (user === null || !canManage) {
    return (
      <div className="py-24 text-center text-sm">
        <Heading className="mb-2">Not authorized</Heading>
        <TypographyP className="text-muted-foreground">
          Only admins can view project details.
        </TypographyP>
      </div>
    );
  }

  if (detailQuery.isLoading) {
    return <Skeleton variant="overview" className="py-4" />;
  }
  if (detail === null || detail === undefined) {
    return (
      <div className="py-24 text-center text-sm">
        <Heading className="mb-2">Project not found</Heading>
        <TypographyP className="text-muted-foreground">
          It may have been deleted or you may not have access.
        </TypographyP>
      </div>
    );
  }

  // The form bodies expect a ProjectListItem shape.
  const asListItem = {
    id: detail.id,
    slug: detail.slug,
    name: detail.name,
    address: detail.address,
    reraNumber: detail.reraNumber ?? null,
    cmdaNumber: detail.cmdaNumber ?? null,
    createdAt: detail.createdAt,
  };

  const leads = Array.isArray(leadsQuery.data) ? leadsQuery.data : [];
  const units = Array.isArray(unitsQuery.data) ? unitsQuery.data : [];

  return (
    // T-DASH-MOBILE: tighten section gap on phones (16px) vs desktop (24px).
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title={detail.name}
        breadcrumb={[
          { label: 'Admin' },
          { label: 'Projects', href: orgHref(orgSlug, '/admin/projects') },
          { label: detail.name },
        ]}
        subtitle={`${detail.slug} · created ${dateIntl.formatDate(detail.createdAt)}`}
        action={
          <Button
            as={Link}
            variant="outline"
            size="sm"
            href={orgHref(orgSlug, '/admin/projects')}
            className="text-xs"
            data-qa="admin-project-back"
          >
            <LuArrowLeft className="size-4" /> Back to projects
          </Button>
        }
      />

      {/* Identity + actions */}
      <Card
        header={{ title: 'Details', description: 'Project identity and registry fields.' }}
        action={
          <div className="hidden items-center justify-end gap-2 sm:flex">
            <Button variant="outline" size="sm" leftIcon={<LuPencil className="size-4" />} onClick={() => setEditOpen(true)} data-qa="project-edit" className="px-2.5">
              Edit
            </Button>
            <Button variant="outline" size="sm" leftIcon={<LuUsersRound className="size-4" />} onClick={() => setMembersOpen(true)} data-qa="project-staff" className="px-2.5">
              Manage Teams
            </Button>
            <Button variant="ghost" size="sm" leftIcon={<LuTrash2 className="size-4" />} className="px-2.5 text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)} data-qa="project-delete">
              Delete
            </Button>
          </div>
        }
      >
        {/* On phones the header action is hidden; render the 3 actions as a
            full-width, equal 3-col grid below the identity fields so they
            never overflow a narrow viewport. */}
        <div className="space-y-3">
          <div className="space-y-1 text-sm">
            <p><span className="text-muted-foreground">Name:</span> {detail.name}</p>
            <p><span className="text-muted-foreground">Slug:</span> {detail.slug}</p>
            <p><span className="text-muted-foreground">Address:</span> {detail.address}</p>
            <p><span className="text-muted-foreground">RERA:</span> {detail.reraNumber ?? '-'}</p>
            <p><span className="text-muted-foreground">CMDA:</span> {detail.cmdaNumber ?? '-'}</p>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:hidden">
            <Button variant="outline" size="sm" leftIcon={<LuPencil className="size-4" />} onClick={() => setEditOpen(true)} data-qa="project-edit" className="w-full px-1">
              Edit
            </Button>
            <Button variant="outline" size="sm" leftIcon={<LuUsersRound className="size-4" />} onClick={() => setMembersOpen(true)} data-qa="project-staff" className="w-full px-1">
              Staff
            </Button>
            <Button variant="ghost" size="sm" leftIcon={<LuTrash2 className="size-4" />} className="w-full px-1 text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)} data-qa="project-delete">
              Delete
            </Button>
          </div>
        </div>
      </Card>

      {/* Count grid - 2 cols on phones so each KPI stays readable, denser up */}
      <section>
        <div className="mb-2">
          <h2 className="text-sm font-semibold tracking-wide uppercase">At a glance</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {kpiCard('Phases', String(detail.counts.phases), LuLayers, 'inventory', 'text-info')}
          {kpiCard('Units', String(detail.counts.units), LuBuilding2, 'inventory', 'text-info')}
          {kpiCard('Facing & BHK', String(detail.counts.options), LuCompass, 'inventory', 'text-info')}
          {kpiCard('Teams', String(detail.counts.teams), LuUsersRound, 'total', 'text-foreground')}
          {kpiCard('Members', String(detail.counts.teamMembers), LuUserRound, 'total', 'text-foreground')}
          {kpiCard('Leads', String(detail.counts.leads), LuContactRound, 'leads', 'text-warning-foreground')}
          {kpiCard(
            'Bookings',
            String(detail.counts.bookings),
            LuBadgeIndianRupee,
            'leads',
            'text-warning-foreground',
          )}
        </div>
      </section>

      {/* Per-project KPIs (reuse dashboard stats) */}
      <section>
        <div className="mb-2">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Pipeline activity</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {kpiCard(
            'New today',
            String(stats?.kpis.newLeadsToday ?? 0),
            LuUserPlus,
            'inventory',
            'text-info',
          )}
          {kpiCard(
            'Overdue',
            String(stats?.kpis.overdueLeads ?? 0),
            LuAlarmClockOff,
            'urgent',
            'text-destructive',
          )}
          {kpiCard(
            "Today's visits",
            String(stats?.kpis.visitsToday ?? 0),
            LuCalendarCheck,
            'leads',
            'text-warning-foreground',
          )}
          {kpiCard('Leads total', String(detail.counts.leads), LuContactRound, 'total', 'text-foreground')}
        </div>
      </section>

      {/* Leads */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Leads</h2>
          <span className="text-muted-foreground text-xs tabular-nums">{detail.counts.leads}</span>
        </div>
        {leadsQuery.isLoading ? (
          <Skeleton variant="table" />
        ) : leads.length === 0 ? (
          <p className="text-muted-foreground text-sm">No leads in this project yet.</p>
        ) : (
          <ul className="border-border divide-border divide-y rounded-lg border">
            {leads.map((lead) => {
              const row = lead as { id?: string; name?: string; ownerName?: string };
              return (
                <li key={row.id ?? ''} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm sm:gap-4 sm:px-4">
                  <span className="truncate">{row.name ?? '(no name)'}</span>
                  <span className="shrink-0 text-muted-foreground text-xs">{row.ownerName ?? 'unassigned'}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Inventory units + phases (stacks into one column on phones) */}
      <section className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <Card header={{ title: 'Units' }}>
          {unitsQuery.isLoading ? (
            <Skeleton variant="table" />
          ) : units.length === 0 ? (
            <p className="text-muted-foreground text-sm">No units in this project yet.</p>
          ) : (
            <ul className="divide-border divide-y">
              {units.map((unit) => {
                const row = unit as { id: string; unitNumber?: string; bhk?: number; facing?: string | null; status?: string };
                return (
                  <li key={row.id} className="flex items-center justify-between gap-3 py-2 text-sm sm:gap-4">
                    <span className="truncate">Unit {row.unitNumber ?? ''}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {row.bhk ? `${row.bhk} BHK` : ''}
                      {row.facing ? ` · ${row.facing}` : ''} · {row.status ?? ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <PhasesSection phases={phasesQuery.data ?? []} projectId={projectId} canManage={canManage} />
      </section>

      {/* Options grid - one column on phones, two on desktop */}
      <section className="grid gap-4 sm:grid-cols-2 sm:gap-6">
        <FacingOptionsCard options={optionsQuery.data ?? []} projectId={projectId} canManage={canManage} />
        <BhkOptionsCard options={optionsQuery.data ?? []} projectId={projectId} canManage={canManage} />
      </section>

      {/* Team roster */}
      <section>
        <div className="mb-2">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Teams & members</h2>
        </div>
        {canManage ? (
          <ProjectTeamList
            projectId={detail.id}
            projectName={detail.name}
            projectSlug={detail.slug}
            canManage
          />
        ) : (
          <p className="text-muted-foreground text-sm">Only admins can view teams.</p>
        )}
      </section>

      {/* Edit / Delete / Staff dialogs (reuse the registry bodies) */}
      <Dialog open={editOpen} onOpenChange={setEditOpen} header={{ title: 'Edit project' }} trigger={<button hidden />} contentClassName="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-lg">
        <ProjectFormBody mode="edit" project={asListItem} onDone={() => setEditOpen(false)} />
      </Dialog>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen} header={{ title: 'Delete project' }} trigger={<button hidden />} contentClassName="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-lg">
        <ProjectDeleteBody project={asListItem} onDone={() => setDeleteOpen(false)} />
      </Dialog>
      <Dialog open={membersOpen} onOpenChange={setMembersOpen} header={{ title: 'Manage Teams', description: detail.name }} trigger={<button hidden />} contentClassName="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-lg">
        <ProjectTeamList projectId={detail.id} projectName={detail.name} projectSlug={detail.slug} canManage />
      </Dialog>
    </div>
  );
}
