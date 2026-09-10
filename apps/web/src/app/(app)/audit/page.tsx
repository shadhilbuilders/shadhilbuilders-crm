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
};

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

  const columns = useMemo<DataTableColumnDef<AuditRow>[]>(
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
          const label = actionLabel(row.original.action);
          const isMapped = label !== row.original.action;
          return (
            <div className="min-w-40">
              <span className="text-sm font-medium">{label}</span>
              {isMapped ? (
                <span className="text-muted-foreground block font-mono text-xs">
                  {row.original.action}
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
        cell: ({ row }) => (
          <span className="text-muted-foreground block max-w-80 font-mono text-xs">
            {formatBeforeAfter(row.original.before, row.original.after)}
          </span>
        ),
        enableSorting: false,
      },
    ],
    [],
  );

  return (
    <div className="space-y-2">
      <DataTable
        columns={columns}
        rows={rows}
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
