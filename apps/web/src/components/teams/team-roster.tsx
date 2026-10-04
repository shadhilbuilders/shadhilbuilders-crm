'use client';

// Shared team-roster member row - T-TEAM-AUTHORITATIVE (2026-09-13, design
// doc UI1): "Managers receive a Work -> My Team route outside the Admin
// navigation... Both routes render the same shared roster component so
// role-specific surfaces cannot drift."
//
// Used by both Admin -> Teams -> [teamId] (ADMIN/OWNER, full actions) and
// Work -> My Team -> [teamId] (MANAGER, remove-only on teams they manage).
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
import { Badge, Button, toast } from '@paalstack/react-ui';

import type { TeamMemberRow } from '@/hooks/queries/teams';
import { labelFor } from '@/lib/labels';
import { useUpdateTeamMemberCap, useUpdateTeamMemberWeight } from '@/hooks/queries/teams';
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
   * Admin -> Teams, `my-team-member-*` on My Team) - kept caller-side so
   * consolidating the component doesn't silently change either surface's
   * data-qa contract. */
  dataQaPrefix?: string;
}) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const [weight, setWeight] = useState<string>(String(member.weight ?? 1));
  const [weightSaving, setWeightSaving] = useState(false);
  // T-MAXOPENLEADS (2026-09-28): the ceiling editor. '' means no cap (null).
  const [cap, setCap] = useState<string>(
    member.maxOpenLeads === null || member.maxOpenLeads === undefined
      ? ''
      : String(member.maxOpenLeads),
  );
  const [capSaving, setCapSaving] = useState(false);
  const isManagerRow = member.userId === managerId;
  const updateWeight = useUpdateTeamMemberWeight();
  const updateCap = useUpdateTeamMemberCap();

  // T-AUTOASSIGN (2026-09-17): only TELECALLER rows are routable, so only they
  // get a weight editor; the manager row never does (a manager doesn't take
  // auto-assigned leads as a telecaller) and neither does a SALES_EXEC row
  // (2026-09-28: the auto-assign pool is telecaller-only, so an exec's weight
  // is inert - the roster shows "Not auto-assigned" instead). Only the viewer
  // who may mutate members may edit weight at all.
  // Weight is a SHARE of new leads, not a cap - see the input's title below.
  const canEditWeight =
    canRemove && !isManagerRow && member.role === 'TELECALLER';

  async function commitWeight(next: string) {
    const parsed = Number(next);
    // Empty/invalid/negative → revert to the last committed value.
    if (!Number.isInteger(parsed) || parsed < 0) {
      setWeight(String(member.weight ?? 1));
      return;
    }
    if (parsed === (member.weight ?? 1)) return;
    setWeightSaving(true);
    try {
      await updateWeight.mutateAsync({ teamId, userId: member.userId, weight: parsed });
      // Reflect the new value immediately - the input stays stale until the
      // query cache is invalidated/refetched otherwise.
      setWeight(String(parsed));
      toast.success('Routing weight updated');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not update weight');
      setWeight(String(member.weight ?? 1));
    } finally {
      setWeightSaving(false);
    }
  }

  /**
   * T-MAXOPENLEADS (2026-09-28): commit the open-lead ceiling.
   *
   * BLANK means "no cap" (null), which is different from 0 ("send nothing") -
   * so an empty field is a VALID value here, not an invalid one to revert. The
   * stored value is compared against the parsed intent, not the raw string, so
   * blanking an uncapped member is a no-op rather than a pointless write.
   */
  async function commitCap(next: string) {
    const trimmed = next.trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    const current = member.maxOpenLeads ?? null;
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0)) {
      setCap(current === null ? '' : String(current));
      return;
    }
    if (parsed === current) return;
    setCapSaving(true);
    try {
      await updateCap.mutateAsync({
        teamId,
        userId: member.userId,
        maxOpenLeads: parsed,
      });
      setCap(parsed === null ? '' : String(parsed));
      toast.success(
        parsed === null
          ? 'Open-lead cap removed'
          : `Capped at ${parsed} open ${parsed === 1 ? 'lead' : 'leads'}`,
      );
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not update the cap');
      setCap(current === null ? '' : String(current));
    } finally {
      setCapSaving(false);
    }
  }

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
        {canEditWeight ? (
          // T-AUTOASSIGN (2026-09-17): inline routing-weight editor. Weight is
          // a SHARE of new leads (higher = a bigger share of the same incoming
          // flow), never a cap - a telecaller is not closed after N leads.
          // Commits on blur/Enter; reverts on invalid input.
          <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span
              title="Share of new leads, not a limit: leads go to whoever has the fewest open leads per weight point. 0 takes this person out of auto-assign."
              className="cursor-help"
            >
              Weight
            </span>
            <input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              onBlur={(e) => void commitWeight(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitWeight((e.target as HTMLInputElement).value);
              }}
              disabled={weightSaving}
              className="border-border text-foreground focus-visible:ring-ring h-7 w-16 rounded-md border bg-transparent px-2 text-right text-xs tabular-nums focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
              aria-label={`Routing weight for ${member.name}`}
              data-qa={`${dataQaPrefix}-weight-${member.userId}`}
            />
          </label>
        ) : !isManagerRow && member.role === 'SALES_EXEC' ? (
          // Sales exec: not in the auto-assign pool (new leads are telecaller
          // work), so show the stored weight read-only rather than pretending
          // it routes anything. Leads reach an exec by handoff or reassign.
          <span
            className="text-muted-foreground text-xs"
            title="Sales execs don't receive auto-assigned new leads; these come from handoff or reassignment."
            data-qa={`${dataQaPrefix}-weight-inert-${member.userId}`}
          >
            Not auto-assigned
          </span>
        ) : null}
        {canEditWeight ? (
          // T-MAXOPENLEADS (2026-09-28): the hard ceiling, on its own row so it
          // reads as a separate control from the share. Blank = no cap.
          <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span
              title="Stop auto-assigning to this person once they hold this many open leads. Leave blank for no limit; 0 sends them nothing. When everyone is at their cap the lead goes to the team manager."
              className="cursor-help"
            >
              Max open
            </span>
            <input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={cap}
              placeholder="No cap"
              onChange={(e) => setCap(e.target.value)}
              onBlur={(e) => void commitCap(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitCap((e.target as HTMLInputElement).value);
              }}
              disabled={capSaving}
              className="border-border text-foreground placeholder:text-muted-foreground focus-visible:ring-ring h-7 w-16 rounded-md border bg-transparent px-2 text-right text-xs tabular-nums focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
              aria-label={`Maximum open leads for ${member.name}`}
              data-qa={`${dataQaPrefix}-cap-${member.userId}`}
            />
          </label>
        ) : null}
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
