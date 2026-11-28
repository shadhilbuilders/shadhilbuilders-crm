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
//   - Timeline renders the activity rows (newest first) with the
//     acting user's name joined in ("First call (Asha)").
import {
  AlertDialog,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  toast,
} from '@paalstack/react-ui';
import { dateIntl } from '@paalstack/react-ui/lib';
import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { LeadActionPanel } from '@/components/shared/LeadActionPanel';
import { LeadFactsPanel } from '@/components/leads/lead-facts-panel';
import { LeadMarketingConsent } from '@/components/leads/lead-marketing-consent';
import { LeadChatPane } from '@/components/shared/LeadChatPane';
import { LeadStatusBadge } from '@/components/shared/LeadStatusBadge';
import { LeadVisitPanel } from '@/components/shared/LeadVisitPanel';
import { PhoneNumber } from '@/components/shared/PhoneNumber';
import { ModulePending } from '@/components/shared/ModulePending';
import { Skeleton } from '@/components/shared/Skeleton';
import { useDeleteLead, useLead, useLeadActivities } from '@/hooks/queries/crm';
import { canDeleteLeads, useSessionUser } from '@/lib/session';
import { labelFor } from '@/lib/labels';

import { PageHeader } from '@/components/shared/PageHeader';
import { projectHref } from '@/lib/nav';
import { useOrgSlug, useProjectSlug } from '@/lib/tenant-context';
import type { LeadDetail } from '@shadhil/api-types';
import { LeadTimeline } from '@/components/leads/lead-timeline';
import { LeadEditDialog } from '@/components/leads/LeadEditDialog';
import { LuPencil, LuTrash2 } from '@paalstack/react-icons/lu';

export default function LeadDetailPage() {
  const params = useParams<{ id: string }>();
  const leadId = typeof params?.id === 'string' ? params.id : null;
  // T-ProjectSwitch: back-navigation and breadcrumbs stay inside the
  // active project (slug-keyed via tenant context).
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();

  const leadQuery = useLead(leadId);
  const activitiesQuery = useLeadActivities(leadId);

  // Delete lives here as well as in the list (2026-11-23): you decide a lead is
  // junk while READING it, and sending the operator back to the queue to hunt
  // for the same row is how junk survives. Same role gate and same guarded
  // endpoint; the UI hiding it is defence in depth, the server refuses anyway.
  const router = useRouter();
  const { user } = useSessionUser();
  const canDelete = user !== null && canDeleteLeads(user.role);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Edit sits beside Delete (T-NOTES, 2026-11-27): the note is written while
  // you are reading the lead, and until now the only editor lived in the inbox
  // row menu.
  const [editOpen, setEditOpen] = useState(false);
  const deleteLead = useDeleteLead(leadId);

  // Pages arrive newest-first; each page is oldest-first. Reverse each page so
  // the feed reads newest -> oldest, with older pages appended below.
  const activities = useMemo(
    () =>
      activitiesQuery.data === undefined
        ? undefined
        : activitiesQuery.data.pages.flatMap((p) => [...p.items].reverse()),
    [activitiesQuery.data],
  );

  const lead = leadQuery.data;
  const leadName = typeof lead?.name === 'string' ? lead.name : 'Detail';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Lead"
        breadcrumb={[
          { label: 'Work' },
          { label: 'Leads', href: projectHref(orgSlug, projectSlug, '/leads') },
          { label: leadName },
        ]}
        action={
          lead !== undefined && lead !== null ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                leftIcon={<LuPencil className="size-4" />}
                onClick={() => setEditOpen(true)}
                data-qa="lead-edit-button"
              >
                Edit
              </Button>
              {canDelete ? (
                <Button
                  variant="soft"
                  color="danger"
                  size="sm"
                  leftIcon={<LuTrash2 className="size-4" />}
                  onClick={() => setDeleteOpen(true)}
                  data-qa="lead-delete-button"
                >
                  Delete
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />

      <LeadEditDialog
        lead={
          lead !== undefined && lead !== null
            ? {
                id: lead.id,
                name: lead.name,
                phone: lead.phone,
                email: lead.email,
                notes: lead.notes,
                budget: lead.budget,
              }
            : null
        }
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={() => {
          void leadQuery.refetch();
        }}
      />

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open) setDeleteOpen(false);
        }}
        trigger={null}
        header={{
          title: `Delete ${leadName}?`,
          description:
            'This permanently removes the lead, its chat history, activities, and visits. A lead that is WON or has booking history cannot be deleted - close it as LOST instead. This action cannot be undone.',
        }}
        cancelButtonText="Cancel"
        confirmButtonText={deleteLead.isPending ? 'Deleting...' : 'Delete lead'}
        confirmButtonProps={{ variant: 'destructive', disabled: deleteLead.isPending }}
        onConfirm={() => {
          deleteLead.mutate(undefined, {
            onSuccess: () => {
              toast.success(`Lead ${leadName} deleted`);
              setDeleteOpen(false);
              // Back to the queue: this page's data no longer exists.
              void router.replace(projectHref(orgSlug, projectSlug, '/leads'));
            },
            onError: (error) => {
              // Server copy verbatim: the 409 names the reason and the way out.
              toast.error(error instanceof Error ? error.message : 'Delete failed');
            },
          });
        }}
        onCancel={() => setDeleteOpen(false)}
      />

      {leadQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div className="space-y-4">
            <Skeleton variant="card" />
            <Skeleton variant="list" count={4} />
          </div>
          <Skeleton variant="card" />
        </div>
      ) : lead !== undefined && lead !== null ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          {/* Left - lead info + actions + timeline */}
          <div className="space-y-4">
            <LeadInfoCard lead={lead} />
            <LeadMarketingConsent lead={lead} />
            <LeadFactsPanel leadId={lead.id} />
            <LeadActionPanel lead={lead} />
            <LeadVisitPanel lead={lead} />
            <LeadTimeline
              leadName={lead.name}
              activities={activities}
              hasMore={activitiesQuery.hasNextPage === true}
              isLoadingMore={activitiesQuery.isFetchingNextPage}
              onLoadMore={() => void activitiesQuery.fetchNextPage()}
              isLoading={activitiesQuery.isLoading}
            />
          </div>

          {/* Right - embedded chat (permanently visible on desktop).
              LeadChatPane renders its own Card (border + rounding).
              Cap the aside to the viewport + sticky so the composer is
              always visible and the scroller can't grow the page. */}
          <aside className="min-w-0 self-start overflow-hidden lg:sticky lg:top-24 lg:h-[calc(100dvh-14rem)]">
            <LeadChatPane
              leadId={leadId}
              leadName={lead.name}
              whatsapp={lead.whatsapp}
              onRecheckWhatsApp={() => {
                // Re-reads the lead, which is where the verdict comes from.
                void leadQuery.refetch();
              }}
            />
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
    // T-LEAD-BUDGET: the band, labelled the way a buyer says it. A lead nobody
    // has asked sits at '-' like the other unknown columns rather than
    // inventing a band.
    {
      label: 'Budget',
      value: typeof lead.budget === 'string' ? labelFor('leadBudget', lead.budget) : null,
    },
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
              <dd className="text-sm">{row.value ?? '-'}</dd>
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
        {/* T-NOTES: what the rep knows in their own words - budget, preferred
            city, whatever came off the brochure. Kept out of the definition
            list because it is prose, not a one-line fact. */}
        {typeof lead.notes === 'string' && lead.notes.trim().length > 0 ? (
          <div className="border-t pt-3" data-qa="lead-notes">
            <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Notes
            </div>
            <p className="mt-1 text-sm whitespace-pre-wrap">{lead.notes}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Format an ISO datetime for the timeline / info card. */
function formatDateTime(iso: string): string {
  if (typeof iso !== 'string' || iso.length === 0) return '-';
  const raw = dateIntl.formatDateTime(iso);
  return raw.length === 0 ? '-' : raw;
}
