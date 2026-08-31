'use client';

// Audit Log — Admin view (Wireframes #11): sortable table with
// date/user/action/entity filters + CSV/JSON export (RERA mechanism).
// Backend audit module is a stub in v1 so far — writers exist in the plan
// (Week 7); page shows pending state until then. Admin-only per §4.
import { Button, Heading, TypographyP } from '@paalstack/react-ui';

import { ModulePending } from '@/components/shared/ModulePending';
import { useAuditLog } from '@/hooks/queries/crm';
import { canViewAudit, useSessionUser } from '@/lib/session';

const FILTER_ACTIONS = [
  'LEAD_REASSIGNED',
  'USER_CREATED',
  'ROLE_CHANGED',
  'VISIT_LOGGED',
  'BOOKING_APPROVED',
  'LOGIN',
] as const;

export default function AuditPage() {
  const auditQuery = useAuditLog({ limit: 50 });
  const { user, isPending: sessionPending } = useSessionUser();

  if (sessionPending) {
    return <div className="text-muted-foreground py-24 text-center text-sm">Loading…</div>;
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Heading className="mb-1">Audit Log</Heading>
          <TypographyP className="text-muted-foreground text-sm">
            Every login, lead view, state transition, message, call, and
            consent change. 7-year retention (RERA).
          </TypographyP>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="min-h-11" disabled>
            Export CSV
          </Button>
          <Button variant="outline" size="sm" className="min-h-11" disabled>
            Export JSON
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {FILTER_ACTIONS.map((action) => (
          <Button key={action} variant="outline" size="sm" className="min-h-11" disabled>
            {action.replace(/_/g, ' ').toLowerCase()}
          </Button>
        ))}
      </div>

      {auditQuery.isLoading ? (
        <div className="text-muted-foreground py-16 text-center text-sm">
          Loading audit entries…
        </div>
      ) : auditQuery.data !== undefined && Array.isArray(auditQuery.data) ? (
        <AuditTable rows={auditQuery.data as Record<string, unknown>[]} />
      ) : (
        <ModulePending
          title="Audit log"
          description="Append-only action ledger with before/after payloads, filterable and exportable for RERA inspection (Wireframe #11). The audit writer + reader ships in Implementation Plan Week 7."
          error={auditQuery.error}
        />
      )}
    </div>
  );
}

function AuditTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) {
    return (
      <div className="border-border rounded-lg border p-10 text-center">
        <p className="text-sm font-medium">No audit entries match.</p>
      </div>
    );
  }
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-border bg-muted/40 border-b text-left">
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">Timestamp</th>
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">User</th>
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">Action</th>
            <th className="hidden px-4 py-2.5 text-xs font-medium tracking-wide uppercase sm:table-cell">Entity</th>
            <th className="hidden px-4 py-2.5 text-xs font-medium tracking-wide uppercase md:table-cell">Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-border border-b last:border-b-0">
              <td className="px-4 py-2.5 tabular-nums">
                {typeof row.createdAt === 'string'
                  ? new Date(row.createdAt).toLocaleString('en-IN')
                  : '—'}
              </td>
              <td className="px-4 py-2.5">{String(row.userName ?? row.userId ?? '—')}</td>
              <td className="px-4 py-2.5 font-mono text-xs">{String(row.action ?? '—')}</td>
              <td className="text-muted-foreground hidden px-4 py-2.5 sm:table-cell">
                {String(row.entityType ?? '—')}
                {row.entityId !== undefined ? ` · ${String(row.entityId)}` : ''}
              </td>
              <td className="text-muted-foreground hidden max-w-[16rem] truncate px-4 py-2.5 font-mono text-xs md:table-cell">
                {row.after !== undefined && row.after !== null
                  ? JSON.stringify(row.after).slice(0, 120)
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}