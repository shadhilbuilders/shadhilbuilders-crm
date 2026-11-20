'use client';

// Column definitions for the Invites table.
//
// Split out of InvitesTab so the tab stays under the 200-line red flag and so
// the column set is unit-testable without rendering a table.
//
// THE COMPACT SET IS THE MOBILE DESIGN, not a degradation. Below `md` only
// Name / Status / Actions remain - the three that answer "who is this, are they
// in, what can I do". Phone / Email / Role / Team / Expires are dropped because
// the actions menu already ADDRESSES the phone (a tap, not a read) and the
// email is in the link the admin is about to send. Truncating six columns into
// 288px would instead produce a sideways-scrolling table where the actions
// menu - the only thing that matters - ends up off-screen.
import { TypographyP } from '@paalstack/react-ui';
import type { DataTableColumnDef } from '@paalstack/react-ui';
import { Tooltip } from '@paalstack/react-ui';

import type { InviteRow } from '@shadhil/api-types';
import { formatPhone } from '@/lib/phone';
import { labelFor } from '@/lib/labels';

import { InviteStatusBadge } from './InviteStatusBadge';

/** Columns dropped on a phone. Exported so the tab and its test agree. */
export const INVITE_COMPACT_DROPPED = new Set([
  'email',
  'phone',
  'role',
  'team',
  'expiresAt',
]);

export function buildInviteColumns({
  compact,
  actionsCell,
}: {
  compact: boolean;
  actionsCell: (row: InviteRow) => React.ReactNode;
}): DataTableColumnDef<InviteRow>[] {
  const all: DataTableColumnDef<InviteRow>[] = [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => (
        <div className={compact ? 'min-w-0' : 'min-w-40'}>
          <span className="text-sm font-medium" data-qa={`invite-name-${row.original.id}`}>
            {row.original.name}
          </span>
          {/* On a phone the email is dropped as a COLUMN but kept here as
              secondary text: the admin needs to know which address will become
              the login, and it is one line. */}
          {compact ? (
            <span className="text-muted-foreground block truncate text-xs">
              {row.original.email}
            </span>
          ) : null}
        </div>
      ),
      enableSorting: true,
    },
    {
      id: 'email',
      accessorKey: 'email',
      header: 'Email',
      cell: ({ row }) => (
        // truncate + tooltip: a long address must not widen the table. The full
        // value stays reachable, which matters because it IS the login address.
        <Tooltip
          content={row.original.email}
          trigger={
            <span className="text-muted-foreground block max-w-[22ch] truncate text-sm">
              {row.original.email}
            </span>
          }
        />
      ),
      enableSorting: true,
    },
    {
      id: 'phone',
      header: 'Phone',
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm" data-qa={`invite-phone-${row.original.id}`}>
          {formatPhone(row.original.phone)}
        </span>
      ),
      enableSorting: false,
    },
    {
      id: 'role',
      header: 'Role',
      cell: ({ row }) => (
        <span className="text-sm">{labelFor('role', row.original.role)}</span>
      ),
      enableSorting: false,
    },
    {
      id: 'team',
      header: 'Team',
      cell: ({ row }) =>
        row.original.team === null ? (
          <span className="text-muted-foreground text-sm">-</span>
        ) : (
          <span className="text-sm">{row.original.team.name}</span>
        ),
      enableSorting: false,
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <InviteStatusBadge
          status={row.original.status}
          testId={`invite-status-${row.original.id}`}
        />
      ),
      enableSorting: false,
    },
    {
      id: 'expiresAt',
      header: 'Expires',
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">
          {new Date(row.original.expiresAt).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </span>
      ),
      enableSorting: false,
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => actionsCell(row.original),
      enableSorting: false,
      enableHiding: false,
    },
  ];

  if (!compact) return all;
  return all.filter((column) => !INVITE_COMPACT_DROPPED.has(column.id ?? ''));
}

/** The empty state, shared so the tab and its test render the same copy. */
export function InvitesEmptyState({ createTrigger }: { createTrigger: React.ReactNode }) {
  return (
    <div className="space-y-1 rounded-lg p-10 text-center">
      <TypographyP className="text-xl font-medium">No invites yet.</TypographyP>
      <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
        Invite a staff member and send them a link - they set their own password.
      </TypographyP>
      <div className="flex justify-center pt-2">{createTrigger}</div>
    </div>
  );
}
