'use client';

// Team create/edit/delete/reassign dialog bodies - T-TEAM-CRUD (2026-09-13).
// Mirrors apps/web/src/components/projects/project-form-bodies.tsx (rule 7c):
// the Dialog wrapper is a shell; these bodies are the testable contract.
//
// Create/Edit -> POST/PATCH /api/teams (ADMIN/OWNER; server validates the
//   managerId candidate: must be role=MANAGER, must not already lead a
//   DIFFERENT team - 409 verbatim otherwise).
// Delete -> DELETE /api/teams/:id (ADMIN/OWNER; 409 when members or an
//   active manager still exist). The delete body renders that 409 message
//   AND a "Reassign all members" shortcut so the admin can unblock the
//   delete without leaving the dialog.
// Reassign -> POST /api/teams/:id/reassign-members (ADMIN/OWNER; omitting
//   userIds moves EVERY member - the one-click bulk action).

import {
  AlertDialog,
  Button,
  Combobox,
  Form,
  toast,
  TypographyP,
} from '@paalstack/react-ui';
import type { FormFieldItemType } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import z from 'zod';

import { CreateTeamDtoSchema } from '@shadhil/api-types';
import {
  useCreateTeam,
  useDeleteTeam,
  useReassignTeamMembers,
  useTeams,
  useUpdateTeam,
  type TeamListItem,
} from '@/hooks/queries/teams';
import { useUsers } from '@/hooks/queries/users';

// ---------------------------------------------------------------------------
// Create / edit form body (rule 7c: separately exported component).
// ---------------------------------------------------------------------------

const NO_MANAGER = '__none__';

type TeamFormValues = z.infer<typeof CreateTeamDtoSchema>;

export function TeamFormBody({
  mode,
  team,
  onDone,
}: {
  mode: 'create' | 'edit';
  team?: TeamListItem;
  onDone: () => void;
}) {
  const createTeam = useCreateTeam();
  const updateTeam = useUpdateTeam();
  const pending = createTeam.isPending || updateTeam.isPending;

  // Manager candidates: role=MANAGER staff only (server enforces this too;
  // the picker just pre-filters so most submissions succeed on the first try).
  const managersQuery = useUsers({ role: ['MANAGER'], limit: 200 });
  const managerOptions = useMemo(
    () => [
      { value: NO_MANAGER, label: 'No manager' },
      ...(managersQuery.data?.rows ?? []).map((u) => ({
        value: u.id,
        label: `${u.name} (${u.email})`,
      })),
    ],
    [managersQuery.data],
  );

  const form = useForm<TeamFormValues>({
    resolver: zodResolver(CreateTeamDtoSchema),
    defaultValues: {
      name: team?.name ?? '',
      managerId: team?.managerId ?? undefined,
    },
    mode: 'onSubmit',
  });

  function onSubmit(values: TeamFormValues) {
    const managerId =
      values.managerId === undefined || (values.managerId as unknown) === NO_MANAGER
        ? null
        : values.managerId;
    if (mode === 'create') {
      createTeam.mutate(
        { name: values.name.trim(), managerId },
        {
          onSuccess: (created) => {
            toast.success(`Team ${created.name} created`);
            onDone();
          },
          onError: (error: unknown) => {
            toast.error(error instanceof Error ? error.message : 'Create failed');
          },
        },
      );
      return;
    }
    if (team === undefined) return;
    updateTeam.mutate(
      { id: team.id, name: values.name.trim(), managerId },
      {
        onSuccess: (updated) => {
          toast.success(`Team ${updated.name} updated`);
          onDone();
        },
        onError: (error: unknown) => {
          toast.error(error instanceof Error ? error.message : 'Update failed');
        },
      },
    );
  }

  const fields: FormFieldItemType<TeamFormValues>[] = [
    {
      type: 'input',
      name: 'name',
      label: 'Team Name',
      required: true,
      placeholder: 'e.g. North Zone Sales',
      inputProps: {
        maxLength: 120,
        'data-qa': 'team-form-name',
      },
    },
    {
      type: 'custom',
      name: 'managerId',
      label: 'Manager',
      render: ({ field }) => (
        <Combobox
          value={(field.value as string | undefined) ?? NO_MANAGER}
          onValueChange={(v) => field.onChange(v ?? NO_MANAGER)}
          options={managerOptions}
          placeholder="Search managers..."
          loadingMessage="Loading managers..."
          emptyOptionMessage="No managers found."
          selectOptionAsValue
          className="w-full"
          data-qa="team-form-manager"
        />
      ),
    },
  ];

  // Reuse the mutation error (create or update) as an inline message - the
  // server's 409 ("already leads a team") is surfaced verbatim.
  const mutationError = createTeam.error ?? updateTeam.error;
  const actionLabel = mode === 'create' ? 'Create team' : 'Save changes';

  return (
    <div className="space-y-3">
      <Form
        id="team-form"
        form={form}
        onSubmit={onSubmit}
        hideSubmitButton
        hideResetButton
        fields={fields}
      />
      {mutationError instanceof Error ? (
        <p className="text-destructive text-xs">{mutationError.message}</p>
      ) : null}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="submit"
          form="team-form"
          isLoading={pending}
          loadingText="Saving..."
          data-qa="team-form-submit"
        >
          {pending ? 'Saving...' : actionLabel}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm body (409 when members or an active manager still exist).
// Renders the server's message verbatim + an inline "Reassign all members"
// shortcut so the admin can unblock the delete without leaving the dialog.
// ---------------------------------------------------------------------------

export function TeamDeleteBody({
  team,
  onDone,
  onDeleted,
}: {
  team: TeamListItem;
  /** Always called to close the dialog - on Cancel AND after a successful delete. */
  onDone: () => void;
  /**
   * Called ONLY after the team is actually deleted (in addition to
   * `onDone`) - distinct from `onDone` so a caller can navigate away
   * (e.g. the roster page bouncing to /admin/teams) without also
   * navigating when the admin just clicks Cancel. Optional: the list
   * page doesn't need it (the row simply disappears on query invalidation).
   */
  onDeleted?: () => void;
}) {
  const deleteTeam = useDeleteTeam();
  const [reassignOpen, setReassignOpen] = useState(false);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    deleteTeam.mutate(team.id, {
      onSuccess: () => {
        toast.success(`Team ${team.name} deleted`);
        onDone();
        onDeleted?.();
      },
      onError: (error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Delete failed');
      },
    });
  }

  const blockedByMembers =
    deleteTeam.isError &&
    deleteTeam.error instanceof Error &&
    /member/i.test(deleteTeam.error.message);
  const blockedByManager =
    deleteTeam.isError &&
    deleteTeam.error instanceof Error &&
    /led by/i.test(deleteTeam.error.message);

  return (
    <>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <TypographyP>
          Delete <strong>{team.name}</strong>? This soft-deletes the team - it's
          hidden from the org-Teams pages, but historical leads and audit records
          are kept (not erased).
        </TypographyP>
        <TypographyP className="text-muted-foreground text-xs">
          Teams with members or an active manager cannot be deleted - the
          server refuses with 409. Only ADMIN or OWNER can delete.
        </TypographyP>
        {deleteTeam.isError && deleteTeam.error instanceof Error ? (
          <div className="space-y-2">
            <p className="text-destructive text-xs">{deleteTeam.error.message}</p>
            {blockedByMembers ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setReassignOpen(true)}
                data-qa="team-delete-reassign-shortcut"
              >
                Reassign all members
              </Button>
            ) : null}
            {blockedByManager ? (
              <p className="text-muted-foreground text-xs">
                Edit the team to clear or reassign its manager, then try deleting again.
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onDone}
            disabled={deleteTeam.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={deleteTeam.isPending}
            data-qa="team-delete-confirm"
          >
            {deleteTeam.isPending ? 'Deleting...' : 'Delete team'}
          </Button>
        </div>
      </form>
      <TeamReassignAllDialog
        team={team}
        open={reassignOpen}
        onOpenChange={setReassignOpen}
        onDone={() => {
          setReassignOpen(false);
          // Retry the delete automatically now that members are moved.
          deleteTeam.mutate(team.id, {
            onSuccess: () => {
              toast.success(`Team ${team.name} deleted`);
              onDone();
              onDeleted?.();
            },
            onError: (error: unknown) => {
              toast.error(error instanceof Error ? error.message : 'Delete failed');
            },
          });
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Reassign-all dialog - the one-click bulk action (no userIds -> moves
// EVERY current member of the team). Also reusable stand-alone from the
// list/roster row actions, not just the delete-blocked shortcut above.
// ---------------------------------------------------------------------------

export function TeamReassignAllDialog({
  team,
  open,
  onOpenChange,
  onDone,
}: {
  team: TeamListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful bulk reassign (in addition to closing). */
  onDone?: () => void;
}) {
  const reassignMembers = useReassignTeamMembers(team.id);
  const [targetTeamId, setTargetTeamId] = useState('');

  function handleConfirm() {
    if (!targetTeamId) return;
    reassignMembers.mutate(
      { targetTeamId },
      {
        onSuccess: (result) => {
          toast.success(`${result.count} member(s) reassigned`);
          setTargetTeamId('');
          onOpenChange(false);
          onDone?.();
        },
        onError: (error: unknown) => {
          toast.error(error instanceof Error ? error.message : 'Reassign failed');
        },
      },
    );
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTargetTeamId('');
        onOpenChange(next);
      }}
      trigger={null}
      header={{
        title: `Reassign all members of ${team.name}`,
        description:
          'Every member currently on this team moves to the team you pick below. This does not change the manager.',
      }}
      cancelButtonText="Cancel"
      confirmButtonText={reassignMembers.isPending ? 'Reassigning...' : 'Reassign all'}
      confirmButtonProps={{ disabled: !targetTeamId || reassignMembers.isPending }}
      onConfirm={handleConfirm}
    >
      <TeamTargetPicker
        excludeTeamId={team.id}
        value={targetTeamId}
        onChange={setTargetTeamId}
      />
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Shared target-team Combobox (excludes the source team) - used by the
// bulk reassign dialog above and the per-member "move to team" dialog on
// the roster page.
// ---------------------------------------------------------------------------

export function TeamTargetPicker({
  excludeTeamId,
  value,
  onChange,
}: {
  excludeTeamId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const teamsQuery = useTeams();
  const options = useMemo(
    () =>
      (teamsQuery.data ?? [])
        .filter((t) => t.id !== excludeTeamId)
        .map((t) => ({ value: t.id, label: t.name })),
    [teamsQuery.data, excludeTeamId],
  );
  return (
    <Combobox
      value={value}
      onValueChange={(v) => onChange(v ?? '')}
      options={options}
      placeholder={options.length === 0 ? 'No other teams available' : 'Search teams...'}
      disabled={options.length === 0}
      selectOptionAsValue
      className="w-full"
      data-qa="team-target-picker"
    />
  );
}
