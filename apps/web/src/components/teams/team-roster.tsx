'use client';

// Shared team-roster member row - T-TEAM-AUTHORITATIVE (2026-09-13, design
// doc UI1): "Managers receive a Work -> My Teams route outside the Admin
// navigation... Both routes render the same shared roster component so
// role-specific surfaces cannot drift."
//
// Used by both Admin -> Teams -> [teamId] (ADMIN/OWNER, full actions) and
// Work -> My Teams -> [teamId] (MANAGER, remove-only on teams they manage).
// This component owns the two rules that must never drift between those
// two surfaces:
//   1. The team's manager row is pinned with a Manager badge and NEVER
//      offers "Remove from this team" - manager succession is a separate,
//      admin-only flow (design doc: "Managers see their own leadership row
//      read-only").
//   2. "Remove from this team" appears only when the CALLER says the
//      viewer may remove members from THIS team (`canRemove`) - Owner/
//      Admin can always remove; a Manager only on teams they manage.
//      ("Ordinary memberships held by a manager in another team remain
//      normal removable member rows" - i.e. this is per-team, not
//      per-viewer-role, which is why it's a caller-supplied boolean rather
//      than something this component infers from a role prop.)
//
// Surface-specific extras (Admin's per-project link/unlink chips and
// "Move to team") render through the `extraActions` slot so this stays the
// single source of truth for the parts that must be identical everywhere.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button } from '@paalstack/react-ui';

import type { TeamMemberRow } from '@/hooks/queries/teams';
import { labelFor } from '@/lib/labels';
import { TeamMemberRemovalDialog } from './TeamMemberRemovalDialog';

export function TeamRosterMemberRow({
  teamId,
  teamName,
  member,
  managerId,
  canRemove,
  extraActions,
  dataQaPrefix = 'team-member',
}: {
  teamId: string;
  teamName: string;
  member: TeamMemberRow;
  managerId: string | null;
  /** Whether the CURRENT VIEWER may remove members from THIS team - not a
   * role check (see file header: this is per-team, not per-role). */
  canRemove: boolean;
  /** Surface-specific actions (e.g. Admin's "Link to project", "Move to
   * team") rendered above "Remove from this team" in the actions column. */
  extraActions?: ReactNode;
  /** Existing tests pin distinct qa ids per surface (`team-member-*` on
   * Admin -> Teams, `my-team-member-*` on My Teams) - kept caller-side so
   * consolidating the component doesn't silently change either surface's
   * data-qa contract. */
  dataQaPrefix?: string;
}) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const isManagerRow = member.userId === managerId;

  return (
    <div
      className="border-border flex items-center justify-between gap-2 rounded-lg border p-3"
      data-qa={`${dataQaPrefix}-row-${member.userId}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{member.name}</span>
          {isManagerRow ? (
            <Badge variant="secondary" data-qa={`${dataQaPrefix}-manager-badge-${member.userId}`}>
              Manager
            </Badge>
          ) : null}
          <Badge variant="outline">{labelFor('role', member.role)}</Badge>
        </div>
        <p className="text-muted-foreground text-xs">{member.email}</p>
      </div>
      <div className="flex flex-col items-end gap-1">
        {extraActions}
        {/* Rule 1 + rule 2 (file header): never on the manager row, only
            when the caller says this viewer may remove from THIS team. */}
        {canRemove && !isManagerRow ? (
          <Button
            type="button"
            variant="ghost"
            color="danger"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => setRemoveOpen(true)}
            data-qa={`${dataQaPrefix}-remove-${member.userId}`}
          >
            Remove from this team
          </Button>
        ) : null}
      </div>
      <TeamMemberRemovalDialog
        target={{ teamId, teamName, userId: member.userId, userName: member.name }}
        open={removeOpen}
        onOpenChange={setRemoveOpen}
      />
    </div>
  );
}
