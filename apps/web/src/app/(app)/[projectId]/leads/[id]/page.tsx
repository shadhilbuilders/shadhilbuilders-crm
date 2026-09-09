'use client';

// Lead Detail (Wireframes #5): two-column - left lead info + timeline,
// right embedded chat pane. Renders real data from GET /leads/:id and
// GET /leads/:id/activities (autoplan 2026-09-08).
//
// Layout:
//   - PageHeader (breadcrumb: Work / Leads / <name>) + BackLink
//   - Two-column grid (lg): left = lead info card + action panel +
//     visit panel + timeline; right = embedded chat pane (permanently
//     visible on desktop, per Wireframe #5).
//   - Lead info card shows the full detail row: name, phone, email,
//     source, status badge, owner, co-owner, created/updated.
//   - Timeline renders the activity rows (oldest → newest) with the
//     acting user's name joined in ("First call (Asha)").
import { Card, CardContent, CardHeader, CardTitle, TypographyP } from '@paalstack/react-ui';
import { dateIntl } from '@paalstack/react-ui/lib';
import { useParams } from 'next/navigation';

import { LeadActionPanel } from '@/components/shared/LeadActionPanel';
import { LeadChatPane } from '@/components/shared/LeadChatPane';
import { LeadStatusBadge } from '@/components/shared/LeadStatusBadge';
import { LeadVisitPanel } from '@/components/shared/LeadVisitPanel';
import { PhoneNumber } from '@/components/shared/PhoneNumber';
import { ModulePending } from '@/components/shared/ModulePending';
import { Skeleton } from '@/components/shared/Skeleton';
import {
  useLead,
  useLeadActivities,
} from '@/hooks/queries/crm';
import { labelFor } from '@/lib/labels';

import { PageHeader } from '@/components/shared/PageHeader';
import { projectHref } from '@/lib/nav';
import type { LeadActivity, LeadDetail } from '@shadhil/api-types';

export default function LeadDetailPage() {
  const params = useParams<{ id: string; projectId: string }>();
  const leadId = typeof params?.id === 'string' ? params.id : null;
  // T-ProjectSwitch: back-navigation and breadcrumbs stay inside the
  // active project (first URL segment).
  const projectId = typeof params?.projectId === 'string' ? params.projectId : null;

  const leadQuery = useLead(leadId);
  const activitiesQuery = useLeadActivities(leadId);

  const lead = leadQuery.data;
  const leadName = typeof lead?.name === 'string' ? lead.name : 'Detail';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Lead"
        breadcrumb={[
          { label: 'Work' },
          { label: 'Leads', href: projectHref(projectId, '/leads') },
          { label: leadName },
        ]}
      />

      {leadQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,440px)]">
          <div className="space-y-4">
            <Skeleton variant="card" />
            <Skeleton variant="list" count={4} />
          </div>
          <Skeleton variant="card" />
        </div>
      ) : lead !== undefined && lead !== null ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,440px)]">
          {/* Left - lead info + actions + timeline */}
          <div className="space-y-4">
            <LeadInfoCard lead={lead} />
            <LeadActionPanel lead={lead} />
            <LeadVisitPanel lead={lead} />
            <LeadTimeline
              leadName={lead.name}
              activities={activitiesQuery.data}
              isLoading={activitiesQuery.isLoading}
            />
          </div>

          {/* Right - embedded chat (permanently visible on desktop).
              LeadChatPane renders its own Card (border + rounding).
              Cap the aside to the viewport + sticky so the composer is
              always visible and the scroller can't grow the page. */}
          <aside className="min-w-0 self-start overflow-hidden lg:sticky lg:top-24 lg:h-[calc(100dvh-14rem)]">
            <LeadChatPane leadId={leadId} leadName={lead.name} />
          </aside>
        </div>
      ) : (
        <ModulePending
          title="Lead detail"
          description="Contact, timeline, notes, visit widget, and booking panel for a single lead (Wireframe #5)."
          error={leadQuery.error}
          isLoading={leadQuery.isLoading}
        />
      )}
    </div>
  );
}

/** Lead info card - the full detail row (Wireframe #5 header block). */
function LeadInfoCard({ lead }: { lead: LeadDetail }) {
  const meta: Array<{ label: string; value: string | null }> = [
    { label: 'Source', value: lead.source !== null ? labelFor('source', lead.source) : null },
    { label: 'Owner', value: lead.ownerName },
    { label: 'Co-owner', value: lead.coOwnerName },
    { label: 'Email', value: lead.email },
  ];

  return (
    <Card data-qa="lead-info-card">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-xl">{lead.name}</CardTitle>
          <LeadStatusBadge status={lead.status} />
        </div>
        <div className="text-muted-foreground text-sm">
          <PhoneNumber phone={lead.phone} variant="link" showIcon />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {meta.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                {row.label}
              </dt>
              <dd className="text-sm">{row.value ?? '—'}</dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Created
            </dt>
            <dd className="text-sm">{formatDateTime(lead.createdAt)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Updated
            </dt>
            <dd className="text-sm">{formatDateTime(lead.updatedAt)}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

/** Timeline - the lead's activity feed (oldest → newest). */
function LeadTimeline({
  leadName,
  activities,
  isLoading,
}: {
  leadName: string;
  activities: LeadActivity[] | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="border-border text-xs font-semibold tracking-wide uppercase">
          Timeline
        </div>
        <Skeleton variant="list" count={3} />
      </div>
    );
  }

  const hasActivities = Array.isArray(activities) && activities.length > 0;

  return (
    <Card data-qa="lead-timeline">
      <CardHeader>
        <CardTitle className="text-base">Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        {hasActivities ? (
          <ol className="space-y-0">
            {activities!.map((entry) => (
              <li
                key={entry.id}
                className="border-border flex gap-3 border-b py-3 last:border-b-0"
              >
                <div className="bg-muted-foreground/20 mt-1.5 h-2 w-2 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-sm font-medium">
                      {labelFor('activity', entry.type)}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {formatDateTime(entry.createdAt)}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-sm">{entry.body}</p>
                  {entry.userName !== null ? (
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      by {entry.userName}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <TypographyP className="text-muted-foreground text-sm">
            No activity for {leadName} yet. Timeline entries appear as the lead
            is called, visited, and moved through the pipeline.
          </TypographyP>
        )}
      </CardContent>
    </Card>
  );
}

/** Format an ISO datetime for the timeline / info card. */
function formatDateTime(iso: string): string {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const raw = dateIntl.formatDateTime(iso);
  return raw.length === 0 ? '—' : raw;
}
