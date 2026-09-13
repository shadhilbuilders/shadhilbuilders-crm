'use client';

// Audit Log - Admin view (Wireframes #11). Rebuilt on the @paalstack/react-ui
// DataTable (2026-09-10) to match the users/projects/leads table pattern:
//   - SERVER-side pagination (T-SRVPG): the page passes total/currentPage/
//     onPageChange/onPageSizeChange; each page change refetches { limit,
//     offset } from the API.
//   - Action filter is a server-driven MultiSelect in the toolbar (mirrors
//     the leads status filter) - the backend applies WHERE action IN (...).
//   - Columns: Timestamp → User → Action → Entity → Before → After.
// Audit module (T-AUDIT) returns `{ total, rows }` - useAuditLog unwraps.
import {
  Button,
  Combobox,
  DataTable,
  Heading,
  Loading,
  TypographyP,
} from '@paalstack/react-ui';
import type { DataTableColumnDef } from '@paalstack/react-ui';
import { LuChevronDown, LuChevronRight } from '@paalstack/react-icons/lu';
import { useEffect, useMemo, useState } from 'react';

import { ModulePending } from '@/components/shared/ModulePending';
import { Skeleton } from '@/components/shared/Skeleton';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useAuditLog, useAuditLogRealtime } from '@/hooks/queries/crm';
import { dateIntl } from '@/lib/format';
import { canViewAudit, useSessionUser } from '@/lib/session';

import { PageHeader } from '@/components/shared/PageHeader';

// Filter actions - every action the backend actually writes (auditLog.create
// call sites across the services). Each entry maps the raw action string to a
// friendly label shown in the filter combobox and the Action column.
const FILTER_ACTIONS: Record<string, string> = {
  // Leads
  'lead.create': 'Lead created',
  'lead.update': 'Lead updated',
  'lead.transition': 'Lead transition',
  'lead.reassign': 'Lead reassigned',
  'lead.assigned': 'Lead assigned',
  'lead.delete': 'Lead deleted',
  // Users
  'user.create': 'User created',
  'user.update': 'User updated',
  'user.changeRole': 'Role changed',
  'user.delete': 'User deleted',
  'user.changePassword': 'Password changed',
  // Visits
  'visit.create': 'Visit created',
  'visit.outcome': 'Visit outcome',
  'visit.reschedule': 'Visit rescheduled',
  // Bookings
  'booking.create': 'Booking created',
  'booking.transition': 'Booking transition',
  // Notifications
  'notification.markRead': 'Notification read',
  'notification.emit': 'Notification sent',
  // Chat
  'chat.send': 'Message sent',
  // Projects
  'project.create': 'Project created',
  'project.update': 'Project updated',
  'project.delete': 'Project deleted',
  'project.member.unlink': 'Member unlinked',
  // Teams
  'team.create': 'Team created',
  'team.update': 'Team updated',
  'team.delete': 'Team deleted',
  'team.reassign_members': 'Team members reassigned',
  // Team membership removal (T-TEAM-AUTHORITATIVE, 2026-09-13)
  'team.member.remove': 'Member removed from team',
  'lead.ownership_transfer': 'Lead ownership transferred',
  // Project <-> Team linking (T-TEAM-AUTHORITATIVE, 2026-09-13)
  'project.team.link': 'Team linked to project',
  'project.team.unlink': 'Team unlinked from project',
  // Auth
  'auth.login': 'Login',
};

function actionLabel(action: string): string {
  return FILTER_ACTIONS[action] ?? action;
}

type AuditRow = {
  id: string;
  userId: string | null;
  userName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: string;
  /** T-TEAM-AUTHORITATIVE (2026-09-13, design doc UI6): groups every row
   * from one multi-row transaction (e.g. N lead-ownership transfers + 1
   * membership removal) so they render/collapse as one operation. */
  batchId: string | null;
};

/** Shape of the `after` payload written by team-members.service.ts's
 * reassignAndRemove for the 'team.member.remove' anchor row. */
type TeamMemberRemovePayload = {
  removedUserId: string;
  removedUserName: string | null;
  teamId: string;
  teamName: string | null;
  replacementUserId: string | null;
  replacementName: string | null;
  transferredLeadCount: number;
};

function isTeamMemberRemovePayload(value: unknown): value is TeamMemberRemovePayload {
  return (
    value !== null &&
    typeof value === 'object' &&
    'removedUserId' in value &&
    'teamId' in value &&
    'transferredLeadCount' in value
  );
}

/** Design doc UI6 copy: "{member} removed from {team} · {n} leads
 * transferred to {replacement}." Falls back to raw ids when a name wasn't
 * captured (older rows, before this enrichment landed). */
function batchSummaryText(payload: TeamMemberRemovePayload): string {
  const member = payload.removedUserName ?? payload.removedUserId;
  const team = payload.teamName ?? payload.teamId;
  const base = `${member} removed from ${team}`;
  if (payload.transferredLeadCount === 0) return base;
  const replacement = payload.replacementName ?? payload.replacementUserId ?? 'a replacement';
  return `${base} · ${payload.transferredLeadCount} lead${payload.transferredLeadCount === 1 ? '' : 's'} transferred to ${replacement}`;
}

const DEFAULT_PAGE_SIZE = 25;

export default function AuditPage() {
  const [actionFilter, setActionFilter] = useState<string[]>([]);
  // Server-side pagination (T-SRVPG, mirrors users): page is 1-indexed;
  // offset = (page - 1) * pageSize.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const auditQuery = useAuditLog({
    limit: pageSize,
    offset: (page - 1) * pageSize,
    ...(actionFilter.length > 0 ? { action: actionFilter.join(',') } : {}),
  });
  // T-E2 (Week 6): live audit stream - new rows (from lead transitions,
  // bookings, logins) stream in via SSE and invalidate the list.
  useAuditLogRealtime();
  const { user, isPending: sessionPending } = useSessionUser();
  // T25 (PR3): wire the offline-aware skeleton. When the user is
  // offline and the list is loading, the skeleton surfaces a
  // "Will sync when online" hint.
  const isOnline = useOnlineStatus();
  const [mounted, setMounted] = useState(false);

  // Better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending=true during SSR. Without this gate the
  // server HTML shows the skeleton while hydration swaps it for the real
  // page → "Hydration failed because the server rendered HTML didn't match
  // the client." Render the skeleton for the first client paint too, then
  // swap after mount (same pattern as app-header.tsx).
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending) {
    return <Skeleton variant="users" className="py-4" />;
  }
  if (user === null || !canViewAudit(user.role)) {
    return (
      <div className="py-24 text-center text-sm">
        <Heading className="mb-2">Not authorized</Heading>
        <TypographyP className="text-muted-foreground">
          The audit log is restricted to admins.
        </TypographyP>
      </div>
    );
  }

  const rows = (auditQuery.data?.rows ?? []) as AuditRow[];
  const total = auditQuery.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Log"
        breadcrumb={[{ label: 'Admin' }, { label: 'Audit' }]}
        subtitle="Every login, lead view, state transition, message, call, and consent change. 7-year retention (RERA)."
        action={
          <div className="flex gap-2">
            <Button variant="outline" disabled>
              Export CSV
            </Button>
            <Button variant="outline" disabled>
              Export JSON
            </Button>
          </div>
        }
      />

      {auditQuery.isLoading ? (
        <Skeleton variant="table" isOffline={!isOnline} />
      ) : auditQuery.error !== null && auditQuery.error !== undefined ? (
        <ModulePending
          title="Audit log"
          description="Append-only action ledger with before/after payloads, filterable and exportable for RERA inspection (Wireframe #11)."
          error={auditQuery.error}
        />
      ) : (
        <AuditTable
          rows={rows}
          total={total}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          isFetching={auditQuery.isFetching}
          actionFilter={actionFilter}
          onActionFilterChange={(actions) => {
            setActionFilter(actions);
            setPage(1); // a new filter starts back at page 1
          }}
        />
      )}
    </div>
  );
}

/**
 * T-TEAM-AUTHORITATIVE (2026-09-13, design doc UI6): collapse every row
 * sharing a batchId under its 'team.member.remove' anchor row, expanding
 * to the raw per-lead rows on demand. Exports (a future CSV/JSON button)
 * read the ORIGINAL `rows` array, never this display transform - "exports
 * retain every raw audit row" per the design doc.
 */
type DisplayRow = AuditRow & { isBatchDetail?: boolean };

function buildDisplayRows(rows: AuditRow[], expandedBatchIds: Set<string>): DisplayRow[] {
  const byBatch = new Map<string, AuditRow[]>();
  for (const r of rows) {
    if (r.batchId === null) continue;
    const list = byBatch.get(r.batchId) ?? [];
    list.push(r);
    byBatch.set(r.batchId, list);
  }

  const consumedBatchIds = new Set<string>();
  const out: DisplayRow[] = [];
  for (const row of rows) {
    if (row.batchId === null) {
      out.push(row);
      continue;
    }
    if (row.action === 'team.member.remove') {
      // The anchor row - always shown; its batch siblings render right
      // after it, indented, only while expanded.
      out.push(row);
      consumedBatchIds.add(row.batchId);
      if (expandedBatchIds.has(row.batchId)) {
        const siblings = (byBatch.get(row.batchId) ?? []).filter((r) => r.id !== row.id);
        for (const sibling of siblings) out.push({ ...sibling, isBatchDetail: true });
      }
      continue;
    }
    // A detail row (e.g. lead.ownership_transfer) whose anchor is ALSO on
    // this page: skip it here - it's inserted right after the anchor
    // above instead, in the correct expand/collapse position.
    if (consumedBatchIds.has(row.batchId)) continue;
    const hasAnchorOnPage = (byBatch.get(row.batchId) ?? []).some((r) => r.action === 'team.member.remove');
    if (hasAnchorOnPage) continue;
    // Anchor wasn't on this page (rare - pagination/filter boundary) -
    // render the detail row plainly, unindented.
    out.push(row);
  }
  return out;
}

function AuditTable({
  rows,
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  isFetching,
  actionFilter,
  onActionFilterChange,
}: {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  isFetching: boolean;
  actionFilter: string[];
  onActionFilterChange: (actions: string[]) => void;
}) {
  const actionOptions = useMemo(
    () =>
      Object.entries(FILTER_ACTIONS).map(([value, label]) => ({
        value,
        label,
      })),
    [],
  );

  const [expandedBatchIds, setExpandedBatchIds] = useState<Set<string>>(new Set());
  const toggleBatch = (batchId: string): void => {
    setExpandedBatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  };
  const displayRows = useMemo(() => buildDisplayRows(rows, expandedBatchIds), [rows, expandedBatchIds]);

  const columns = useMemo<DataTableColumnDef<DisplayRow>[]>(
    () => [
      {
        accessorKey: 'createdAt',
        header: 'Timestamp',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm tabular-nums">
            {dateIntl.formatDateTime(row.original.createdAt)}
          </span>
        ),
        enableSorting: true,
      },
      {
        accessorKey: 'userName',
        header: 'User',
        cell: ({ row }) => (
          <span className="text-sm font-medium">
            {row.original.userName?.length
              ? row.original.userName
              : row.original.userId ?? '-'}
          </span>
        ),
        enableSorting: true,
      },
      {
        accessorKey: 'action',
        header: 'Action',
        cell: ({ row }) => {
          const r = row.original;
          const label = actionLabel(r.action);
          const isMapped = label !== r.action;
          // Batch anchor row: an expand/collapse toggle when this batch
          // has other rows on the current page.
          if (r.action === 'team.member.remove' && r.batchId !== null) {
            const expanded = expandedBatchIds.has(r.batchId);
            const hasSiblings = rows.some((o) => o.batchId === r.batchId && o.id !== r.id);
            return (
              <div className="min-w-40">
                <button
                  type="button"
                  className="flex items-center gap-1 text-left"
                  disabled={!hasSiblings}
                  onClick={() => r.batchId !== null && toggleBatch(r.batchId)}
                  data-qa={`audit-batch-toggle-${r.batchId}`}
                >
                  {hasSiblings ? (
                    expanded ? (
                      <LuChevronDown className="text-muted-foreground size-4 shrink-0" />
                    ) : (
                      <LuChevronRight className="text-muted-foreground size-4 shrink-0" />
                    )
                  ) : null}
                  <span className="text-sm font-medium">{label}</span>
                </button>
              </div>
            );
          }
          return (
            <div className={r.isBatchDetail === true ? 'min-w-40 pl-6' : 'min-w-40'}>
              <span className="text-sm font-medium">{label}</span>
              {isMapped ? (
                <span className="text-muted-foreground block font-mono text-xs">
                  {r.action}
                </span>
              ) : null}
            </div>
          );
        },
        enableSorting: true,
      },
      {
        accessorKey: 'entityType',
        header: 'Entity',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {row.original.entityType}
            {row.original.entityId ? ` · ${row.original.entityId}` : ''}
          </span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'before',
        header: 'Before → After',
        cell: ({ row }) => {
          const r = row.original;
          if (r.action === 'team.member.remove' && isTeamMemberRemovePayload(r.after)) {
            return (
              <span className="block max-w-80 text-sm" data-qa={`audit-batch-summary-${r.batchId ?? ''}`}>
                {batchSummaryText(r.after)}
              </span>
            );
          }
          return (
            <span className="text-muted-foreground block max-w-80 font-mono text-xs">
              {formatBeforeAfter(r.before, r.after)}
            </span>
          );
        },
        enableSorting: false,
      },
    ],
    [expandedBatchIds, rows],
  );

  return (
    <div className="space-y-2">
      <DataTable
        columns={columns}
        rows={displayRows}
        showPagination
        paginationProps={{
          total,
          currentPage: page,
          onPageChange,
          pageSize,
          onPageSizeChange,
          pageSizeOptions: [10, 25, 50],
          showTotalResults: true,
          showOnlyIfTotalGreaterThanPageSize: true,
        }}
        isLoading={isFetching}
        loadingContent={<Loading content="Loading audit log..." />}
        toolbarLeftSideContent={
          <Combobox
            multiple
            value={actionFilter}
            onValueChange={(next) =>
              onActionFilterChange((next as string[]) ?? [])
            }
            options={actionOptions}
            placeholder="Filter by action"
            selectOptionAsValue
            className="min-w-48 max-w-96"
            data-qa="audit-action-filter"
          />
        }
        emptyContent={
          <div
            className="rounded-lg p-10 text-center space-y-1"
            data-qa="audit-empty"
          >
            <TypographyP className="text-xl font-medium">
              {actionFilter.length > 0
                ? 'No audit entries match these filters.'
                : total === 0
                  ? 'No audit entries yet.'
                  : 'No entries match these filters.'}
            </TypographyP>
            <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
              {actionFilter.length > 0
                ? 'Try clearing the action filter.'
                : 'Audit rows are written by every mutation in the system - they appear here as the activity happens.'}
            </TypographyP>
          </div>
        }
        tableContainerClassName="rounded-lg border"
      />
    </div>
  );
}

function formatBeforeAfter(before: unknown, after: unknown): string {
  const beforeStr = summarise(before);
  const afterStr = summarise(after);
  if (beforeStr === null && afterStr === null) return '-';
  if (beforeStr === null) return `→ ${afterStr}`;
  if (afterStr === null) return `${beforeStr} →`;
  return `${beforeStr} → ${afterStr}`;
}

function summarise(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  return json.length > 80 ? `${json.slice(0, 77)}...` : json;
}
