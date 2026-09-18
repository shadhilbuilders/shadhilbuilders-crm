'use client';

// Audit Log - Admin view (Wireframes #11). Rebuilt on the @paalstack/react-ui
// DataTable (2026-09-10) to match the users/projects/leads table pattern:
//   - SERVER-side pagination (T-SRVPG): the page passes total/currentPage/
//     onPageChange/onPageSizeChange; each page change refetches { limit,
//     offset } from the API.
//   - Action filter is a server-driven Combobox multiple in the toolbar (mirrors
//     the leads status filter) - the backend applies WHERE action IN (...).
//   - Columns: Timestamp → User → Action → Entity → Before → After.
// Audit module (T-AUDIT) returns `{ total, rows }` - useAuditLog unwraps.
import {
  Button,
  Combobox,
  Pagination,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Heading,
  TypographyP,
} from '@paalstack/react-ui';
import { LuChevronDown, LuChevronRight } from '@paalstack/react-icons/lu';
import { Fragment, useEffect, useMemo, useState } from 'react';

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
  // Which rows have their full before/after payload shown as a child row.
  const [expandedDetailIds, setExpandedDetailIds] = useState<Set<string>>(new Set());
  const toggleDetail = (id: string): void => {
    setExpandedDetailIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const displayRows = useMemo(() => buildDisplayRows(rows, expandedBatchIds), [rows, expandedBatchIds]);

  const emptyText =
    actionFilter.length > 0
      ? 'No audit entries match these filters.'
      : total === 0
        ? 'No audit entries yet.'
        : 'No entries match these filters.';
  const emptySub =
    actionFilter.length > 0
      ? 'Try clearing the action filter.'
      : 'Audit rows are written by every mutation in the system - they appear here as the activity happens.';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-start">
        <Combobox
          multiple
          value={actionFilter}
          onValueChange={(next) =>
            onActionFilterChange((next as string[]) ?? [])
          }
          options={actionOptions}
          placeholder="Filter by action"
          selectOptionAsValue
          maxSelectedChips={2}
          className="min-w-48 max-w-96"
          data-qa="audit-action-filter"
        />
      </div>

      {isFetching && displayRows.length === 0 ? (
        <Skeleton variant="table" />
      ) : displayRows.length === 0 ? (
        <div
          className="rounded-lg border p-10 text-center space-y-1"
          data-qa="audit-empty"
        >
          <TypographyP className="text-xl font-medium">{emptyText}</TypographyP>
          <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
            {emptySub}
          </TypographyP>
        </div>
      ) : (
        <Table
          className="border-border w-full table-fixed rounded-lg border"
          data-qa={
            expandedDetailIds.size > 0 || expandedBatchIds.size > 0
              ? 'audit-table-expanded'
              : 'audit-table'
          }
        >
          <TableHeader data-qa="audit-table-header">
            <TableRow className="border-border border-b">
              <TableHead className="w-10" data-qa="audit-th-expand" aria-label="Expand" />
              <TableHead className="w-40" data-qa="audit-th-timestamp">Timestamp</TableHead>
              <TableHead className="w-32" data-qa="audit-th-user">User</TableHead>
              <TableHead className="w-48" data-qa="audit-th-action">Action</TableHead>
              <TableHead className="w-48" data-qa="audit-th-entity">Entity</TableHead>
              <TableHead data-qa="audit-th-before">Before → After</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody data-qa="audit-table-body">
            {displayRows.map((r) => {
              // Whether THIS row shows a full before/after child row.
              const expandable =
                (r.before !== null && r.before !== undefined) ||
                (r.after !== null && r.after !== undefined) ||
                (r.reason !== null && r.reason !== undefined);
              const detailExpanded = r.id !== null && expandedDetailIds.has(r.id);

              // Batch anchor: its own expand/collapse for the sibling rows.
              const isBatchAnchor = r.action === 'team.member.remove' && r.batchId !== null;
              const batchExpanded = isBatchAnchor && expandedBatchIds.has(r.batchId!);
              const hasBatchSiblings =
                isBatchAnchor && rows.some((o) => o.batchId === r.batchId && o.id !== r.id);

              // One chevron: prefer the detail (child row) expander; show the
              // batch expander only as a secondary toggle inside the action cell.
              const chevron =
                r.isBatchDetail === true ? null : expandable ? (
                  detailExpanded ? (
                    <LuChevronDown className="text-muted-foreground size-4" />
                  ) : (
                    <LuChevronRight className="text-muted-foreground size-4" />
                  )
                ) : null;

              return (
                <Fragment key={r.id}>
                  <TableRow
                    data-qa={`audit-row-${r.id}`}
                    className={
                      r.isBatchDetail === true
                        ? 'bg-muted/30'
                        : expandable
                          ? 'hover:bg-accent cursor-pointer'
                          : undefined
                    }
                    onClick={expandable ? () => toggleDetail(r.id) : undefined}
                  >
                    <TableCell data-qa="audit-expand-cell">
                      {chevron !== null ? (
                        <span
                          className="flex items-center gap-1 text-left"
                          aria-label={detailExpanded ? 'Collapse details' : 'Expand details'}
                        >
                          {chevron}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell data-qa="audit-timestamp">
                      <span className="text-muted-foreground block text-sm tabular-nums">
                        {dateIntl.formatDateTime(r.createdAt)}
                      </span>
                    </TableCell>
                    <TableCell data-qa="audit-user" className="min-w-0">
                      <span className="block w-full truncate text-sm font-medium" title={r.userName?.length ? r.userName : (r.userId ?? '-')}>
                        {r.userName?.length ? r.userName : r.userId ?? '-'}
                      </span>
                    </TableCell>
                    <TableCell data-qa="audit-action" className="min-w-0">
                      <div className={r.isBatchDetail === true ? 'min-w-40 pl-6' : 'min-w-0'}>
                        <div className="flex items-center gap-1">
                          {isBatchAnchor && hasBatchSiblings ? (
                            <button
                              type="button"
                              className="flex shrink-0 items-center gap-1 text-left"
                              disabled={!hasBatchSiblings}
                              onClick={(e) => {
                                // The row is click-to-expand; the batch toggle
                                // must not fall through to the detail expander.
                                e.stopPropagation();
                                if (r.batchId !== null) toggleBatch(r.batchId);
                              }}
                              data-qa={`audit-batch-toggle-${r.batchId}`}
                            >
                              {batchExpanded ? (
                                <LuChevronDown className="text-muted-foreground size-4 shrink-0" />
                              ) : (
                                <LuChevronRight className="text-muted-foreground size-4 shrink-0" />
                              )}
                            </button>
                          ) : null}
                          <span className="truncate text-sm font-medium" title={actionLabel(r.action)}>
                            {actionLabel(r.action)}
                          </span>
                        </div>
                        {actionLabel(r.action) !== r.action ? (
                          <span className="text-muted-foreground block truncate font-mono text-xs" title={r.action}>
                            {r.action}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell data-qa="audit-entity" className="min-w-0">
                      <span className="text-muted-foreground block w-full truncate text-sm" title={r.entityType + (r.entityId ? ` · ${r.entityId}` : '')}>
                        {r.entityType}
                        {r.entityId ? ` · ${r.entityId}` : ''}
                      </span>
                    </TableCell>
                    <TableCell data-qa="audit-before-after" className="min-w-0">
                      {r.action === 'team.member.remove' && isTeamMemberRemovePayload(r.after) ? (
                        <span
                          className="block w-full truncate text-sm"
                          title={batchSummaryText(r.after)}
                          data-qa={`audit-batch-summary-${r.batchId ?? ''}`}
                        >
                          {batchSummaryText(r.after)}
                        </span>
                      ) : (
                        <span
                          className="text-muted-foreground block w-full truncate font-mono text-xs"
                          title={formatBeforeAfter(r.before, r.after)}
                        >
                          {formatBeforeAfter(r.before, r.after)}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>

                  {/* Child row: the full before / after payload for this entry. */}
                  {detailExpanded ? (
                    <TableRow>
                      <TableCell colSpan={6} data-qa={`audit-detail-expanded-${r.id ?? ''}`}>
                        <div className="border-border bg-muted/40 space-y-2 rounded-md border p-3">
                          {r.before === null || r.before === undefined ? null : (
                            <div>
                              <p className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wide uppercase">
                                Before
                              </p>
                              <pre className="text-foreground whitespace-pre-wrap break-all font-mono text-xs">
                                {JSON.stringify(r.before, null, 2)}
                              </pre>
                            </div>
                          )}
                          {r.after === null || r.after === undefined ? null : (
                            <div>
                              <p className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wide uppercase">
                                After
                              </p>
                              <pre className="text-foreground whitespace-pre-wrap break-all font-mono text-xs">
                                {JSON.stringify(r.after, null, 2)}
                              </pre>
                            </div>
                          )}
                          {r.reason !== null && r.reason !== undefined ? (
                            <div>
                              <p className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wide uppercase">
                                Reason
                              </p>
                              <p className="text-foreground text-xs">{r.reason}</p>
                            </div>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Pagination
        total={total}
        currentPage={page}
        pageSize={pageSize}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        pageSizeOptions={[10, 25, 50]}
        showPageSizeOptions
        showTotalResults
        showOnlyIfTotalGreaterThanPageSize
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
