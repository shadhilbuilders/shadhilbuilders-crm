'use client';

// TeamWeightDialog - T-AUTOASSIGN (2026-09-17): one-screen management of the
// per-member routing weight (how many leads each telecaller can handle) for
// a given team. ADMIN/OWNER only (the teams list itself is admin/owner-gated).
//
// Reuses the same weight-commit logic + inline input as the team roster
// (team-roster.tsx): commit on blur/Enter, revert on invalid input. The
// manager row has no editor (a manager never takes auto-assigned leads as a
// telecaller). Weights feed the auto-assign engine's least-loaded pick
// (score = openLeads / weight), so higher = this member gets more leads.
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

import { useTeam, useUpdateTeamMemberWeight, type TeamListItem } from '@/hooks/queries/teams';
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
          'Routing weight = how many auto-assigned leads each member can handle. Higher weight means a larger share. Lower is a lighter share; the manager row is not routable.',
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
  member: { userId: string; name: string; email: string; role: string; weight?: number };
  managerId: string | null;
}) {
  const [weight, setWeight] = useState<string>(String(member.weight ?? 1));
  const [weightSaving, setWeightSaving] = useState(false);
  const isManagerRow = member.userId === managerId;
  const updateWeight = useUpdateTeamMemberWeight();

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
        !isManagerRow ? (
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
              className="w-16 h-7 text-right text-xs tabular-nums"
              aria-label={`Routing weight for ${member.name}`}
              data-qa={`team-weight-input-${member.userId}`}
            />
          </Label>
        ) : undefined
      }
    />
  );
}
