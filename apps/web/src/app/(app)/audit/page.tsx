'use client';

// Audit Log — Admin view (Wireframes #11): sortable table with
// date/user/action/entity filters. Audit module (T-AUDIT, Pass 1)
// returns `{ total, rows }` — useAuditLog unwraps (T-F1).
import { Button } from '@paalstack/react-ui';
import { useState } from 'react';

import { Heading, TypographyP } from '@paalstack/react-ui';
import { ModulePending } from '@/components/shared/ModulePending';
import { Skeleton } from '@/components/shared/Skeleton';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { useAuditLog } from '@/hooks/queries/crm';
import { canViewAudit, useSessionUser } from '@/lib/session';

import { PageHeader } from '../PageHeader';

// Filter chips — only the ones the backend actually filters on
// (AuditLogQueryDtoSchema supports userId / entityType / entityId /
// action / from / to / limit / offset). The legacy placeholder list
// was decoration; we narrow it to actions that the writer layer
// already emits (per the audit interceptor + service-level writes).
const FILTER_ACTIONS = [
  'lead.transition',
  'lead.reassign',
  'user.created',
  'role.changed',
  'visit.log',
  'booking.approve',
  'booking.transition',
  'notification.markRead',
  'auth.login',
] as const;

export default function AuditPage() {
  const [actionFilter, setActionFilter] = useState<string | null>(null);
  const auditQuery = useAuditLog({
    limit: 50,
    ...(actionFilter !== null ? { action: actionFilter } : {}),
  });
  const { user, isPending: sessionPending } = useSessionUser();
  // T25 (PR3): wire the offline-aware skeleton. When the user is
  // offline and the list is loading, the skeleton surfaces a
  // "Will sync when online" hint.
  const isOnline = useOnlineStatus();

  if (sessionPending) {
    return <Skeleton variant="user" className="py-24" />;
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

  const rows = auditQuery.data?.rows ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Log"
        breadcrumb={[{ label: 'Admin' }, { label: 'Audit' }]}
        subtitle="Every login, lead view, state transition, message, call, and consent change. 7-year retention (RERA)."
        action={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="min-h-11" disabled>
              Export CSV
            </Button>
            <Button variant="outline" size="sm" className="min-h-11" disabled>
              Export JSON
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant={actionFilter === null ? 'default' : 'outline'}
          size="sm"
          className="min-h-11"
          onClick={() => setActionFilter(null)}
        >
          All actions
        </Button>
        {FILTER_ACTIONS.map((action) => (
          <Button
            key={action}
            variant={actionFilter === action ? 'default' : 'outline'}
            size="sm"
            className="min-h-11"
            onClick={() => setActionFilter(action)}
          >
            {action}
          </Button>
        ))}
      </div>

      {auditQuery.isLoading ? (
        <Skeleton variant="table" isOffline={!isOnline} />
      ) : rows.length > 0 ? (
        <AuditTable rows={rows as Record<string, unknown>[]} />
      ) : (
        <AuditEmpty
          filter={actionFilter}
          error={auditQuery.error}
          total={auditQuery.data?.total ?? 0}
        />
      )}
    </div>
  );
}

function AuditTable({ rows }: { rows: Record<string, unknown>[] }) {
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-border bg-muted/40 border-b text-left">
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">Timestamp</th>
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">User</th>
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">Action</th>
            <th className="hidden px-4 py-2.5 text-xs font-medium tracking-wide uppercase sm:table-cell">Entity</th>
            <th className="hidden px-4 py-2.5 text-xs font-medium tracking-wide uppercase md:table-cell">Before → After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const id = typeof row.id === 'string' ? row.id : `r-${index}`;
            return (
              <tr key={id} className="border-border border-b last:border-b-0">
                <td className="px-4 py-2.5 tabular-nums">
                  {typeof row.createdAt === 'string'
                    ? new Date(row.createdAt).toLocaleString('en-IN')
                    : '—'}
                </td>
                <td className="px-4 py-2.5">
                  {typeof row.userName === 'string' && row.userName.length > 0
                    ? row.userName
                    : typeof row.userId === 'string'
                      ? row.userId
                      : '—'}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs">
                  {String(row.action ?? '—')}
                </td>
                <td className="text-muted-foreground hidden px-4 py-2.5 sm:table-cell">
                  {String(row.entityType ?? '—')}
                  {row.entityId !== undefined && row.entityId !== null
                    ? ` · ${String(row.entityId)}`
                    : ''}
                </td>
                <td className="text-muted-foreground hidden max-w-[20rem] px-4 py-2.5 font-mono text-xs md:table-cell">
                  {formatBeforeAfter(row.before, row.after)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatBeforeAfter(before: unknown, after: unknown): string {
  const beforeStr = summarise(before);
  const afterStr = summarise(after);
  if (beforeStr === null && afterStr === null) return '—';
  if (beforeStr === null) return `→ ${afterStr}`;
  if (afterStr === null) return `${beforeStr} →`;
  return `${beforeStr} → ${afterStr}`;
}

function summarise(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  return json.length > 80 ? `${json.slice(0, 77)}…` : json;
}

function AuditEmpty({
  filter,
  error,
  total,
}: {
  filter: string | null;
  error: unknown;
  total: number;
}) {
  // The error branch surfaces ModulePending (its 404/501 detection
  // distinguishes "module not built" from "module failed"); the empty
  // branch renders an honest message — both copy respects the
  // audit-trail-is-7-year-retained invariant (no data lies here).
  if (error !== null && error !== undefined) {
    return (
      <ModulePending
        title="Audit log"
        description="Append-only action ledger with before/after payloads, filterable and exportable for RERA inspection (Wireframe #11)."
        error={error}
      />
    );
  }
  return (
    <div
      className="border-border rounded-lg border p-10 text-center"
      data-qa="audit-empty"
    >
      <p className="text-sm font-medium">
        {filter !== null
          ? `No audit entries for "${filter}".`
          : total === 0
            ? 'No audit entries yet.'
            : 'No entries match these filters.'}
      </p>
      <p className="text-muted-foreground mt-1 text-xs">
        {filter !== null
          ? 'Try clearing the action filter.'
          : 'Audit rows are written by every mutation in the system — they appear here as the activity happens.'}
      </p>
    </div>
  );
}