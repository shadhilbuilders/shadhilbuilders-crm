'use client';

// TeamWeightDialog - T-AUTOASSIGN (2026-09-17): one-screen management of the
// per-member routing WEIGHT - a share, not a cap. A telecaller is not closed
// after N leads: the engine scores openLeads / weight and always routes to the
// lowest score, so "Weight 5" means five times someone else's share of the same
// incoming leads, not "five leads then stop".
// ADMIN/OWNER only (the teams list itself is admin/owner-gated).
//
// Reuses the same weight-commit logic + inline input as the team roster
// (team-roster.tsx): commit on blur/Enter, revert on invalid input. Only
// TELECALLER rows get an editor: the manager row never takes auto-assigned
// leads, and since 2026-09-28 the auto-assign pool is telecaller-only, so a
// sales exec's weight is inert (those rows are labelled, not editable).
import { useState } from 'react';
import {
  Badge,
  Dialog,
  Input,
  Item,
  Label,
  Loading,
  toast,
  TypographyP,
} from '@paalstack/react-ui';

import { useTeam, useUpdateTeamMemberCap, useUpdateTeamMemberWeight, type TeamListItem } from '@/hooks/queries/teams';
import { labelFor } from '@/lib/labels';

export function TeamWeightDialog({
  team,
  open,
  onOpenChange,
}: {
  team: TeamListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading, isError } = useTeam(open ? team.id : undefined);
  const members = data?.members ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      header={{
        title: `Manage weights - ${team.name}`,
        description:
          'Two separate controls. Weight is a SHARE of new leads (2 means roughly twice the share of 1) and never a limit. Max open is a HARD CEILING: once a telecaller holds that many open leads they stop receiving new ones, and if everyone is at their cap the lead goes to the team manager. Leave Max open blank for no limit. Managers and sales execs are never auto-assigned new leads.',
      }}
      contentClassName="sm:max-w-lg"
    >
      <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
        {isLoading ? (
          <Loading content="Loading members..." />
        ) : isError || data === undefined ? (
          <TypographyP className="text-sm">Couldn&apos;t load this team and its members.</TypographyP>
        ) : members.length === 0 ? (
          <TypographyP className="text-muted-foreground text-sm">
            No members in this team yet.
          </TypographyP>
        ) : (
          members.map((member) => <WeightRow key={member.userId} teamId={team.id} member={member} managerId={data.manager?.id ?? null} />)
        )}
      </div>
    </Dialog>
  );
}

function WeightRow({
  teamId,
  member,
  managerId,
}: {
  teamId: string;
  member: {
    userId: string;
    name: string;
    email: string;
    role: string;
    weight?: number;
    maxOpenLeads?: number | null;
  };
  managerId: string | null;
}) {
  const [weight, setWeight] = useState<string>(String(member.weight ?? 1));
  const [weightSaving, setWeightSaving] = useState(false);
  // T-MAXOPENLEADS (2026-09-28): '' = no cap (null), which is distinct from 0.
  const [cap, setCap] = useState<string>(
    member.maxOpenLeads === null || member.maxOpenLeads === undefined
      ? ''
      : String(member.maxOpenLeads),
  );
  const [capSaving, setCapSaving] = useState(false);
  const isManagerRow = member.userId === managerId;
  const isSalesExecRow = !isManagerRow && member.role === 'SALES_EXEC';
  const updateWeight = useUpdateTeamMemberWeight();
  const updateCap = useUpdateTeamMemberCap();

  async function commitWeight(next: string) {
    const parsed = Number(next);
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
      toast.success(`Weight updated for ${member.name}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not update weight');
      setWeight(String(member.weight ?? 1));
    } finally {
      setWeightSaving(false);
    }
  }

  /** T-MAXOPENLEADS (2026-09-28): commit the open-lead ceiling (blank = none). */
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
          ? `No cap for ${member.name}`
          : `${member.name} capped at ${parsed} open ${parsed === 1 ? 'lead' : 'leads'}`,
      );
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not update the cap');
      setCap(current === null ? '' : String(current));
    } finally {
      setCapSaving(false);
    }
  }

  return (
    <Item
      variant="outline"
      size="sm"
      data-qa={`team-weight-row-${member.userId}`}
      title={
        <span className="inline-flex items-center gap-1.5">
          {member.name}
          {isManagerRow ? (
            <Badge variant="secondary" data-qa={`team-weight-manager-${member.userId}`}>
              Manager
            </Badge>
          ) : null}
          <Badge variant="muted">{labelFor('role', member.role)}</Badge>
        </span>
      }
      description={member.email}
      actions={
        isManagerRow ? undefined : isSalesExecRow ? (
          <span
            className="text-muted-foreground text-xs"
            title="Sales execs don't receive auto-assigned new leads; these come from handoff or reassignment."
            data-qa={`team-weight-inert-${member.userId}`}
          >
            Not auto-assigned
          </span>
        ) : (
          <div className="flex flex-col items-end gap-1">
            <Label htmlFor={`team-weight-input-${member.userId}`} className="text-muted-foreground flex items-center gap-2 text-xs">
              Weight
              <Input
                id={`team-weight-input-${member.userId}`}
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={weight}
                onValueChange={setWeight}
                onBlur={(e) => void commitWeight(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitWeight((e.target as HTMLInputElement).value);
                }}
                disabled={weightSaving}
                placeholder='0'
                className="w-16 h-7 text-right text-xs tabular-nums text-foreground"
                aria-label={`Routing weight for ${member.name}`}
                data-qa={`team-weight-input-${member.userId}`}
              />
            </Label>
            {/* T-MAXOPENLEADS (2026-09-28): the hard ceiling. Blank = no cap. */}
            <Label htmlFor={`team-cap-input-${member.userId}`} className="text-muted-foreground flex items-center gap-2 text-xs">
              Max open
              <Input
                id={`team-cap-input-${member.userId}`}
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={cap}
                onValueChange={setCap}
                onBlur={(e) => void commitCap(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitCap((e.target as HTMLInputElement).value);
                }}
                disabled={capSaving}
                placeholder="No cap"
                className="w-16 h-7 text-right text-xs tabular-nums text-foreground"
                aria-label={`Maximum open leads for ${member.name}`}
                data-qa={`team-cap-input-${member.userId}`}
              />
            </Label>
          </div>
        )
      }
    />
  );
}
