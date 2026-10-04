'use client';

// AddTeamMembersDialog - add existing telecallers / sales execs to a team.
// ADMIN/OWNER only (the teams surfaces are admin-gated; the server enforces it).
//
// Additive: POST /api/teams/:id/members never removes someone from another
// team (use "Move to team" for that). People already on the team stay visible
// but disabled, so the admin can see why they can't be picked. Managers are
// not offered - they lead a team through the team's manager setting.
// Mount it only while open (like TeamWeightDialog) so the staff query doesn't
// fire for a closed dialog.
import { useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Dialog,
  Input,
  Loading,
  toast,
  TypographyP,
} from '@paalstack/react-ui';
import { useDebouncedValue } from '@paalstack/react-hooks';

import { useAddTeamMembers, useTeam, type TeamListItem } from '@/hooks/queries/teams';
import { useUsers } from '@/hooks/queries/users';
import { labelFor } from '@/lib/labels';

export function AddTeamMembersDialog({
  team,
  open,
  onOpenChange,
}: {
  team: TeamListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const serverSearch = debouncedSearch.trim().length >= 2 ? debouncedSearch.trim() : undefined;

  const teamQuery = useTeam(team.id);
  const usersQuery = useUsers({
    role: ['TELECALLER', 'SALES_EXEC'],
    search: serverSearch,
    limit: 50,
    offset: 0,
  });
  const addMembers = useAddTeamMembers(team.id);

  const memberIds = useMemo(
    () => new Set((teamQuery.data?.members ?? []).map((m) => m.userId)),
    [teamQuery.data],
  );
  // Role + organization filtering happens server-side (GET /api/users?role=...);
  // rows are rendered as returned.
  const rows = usersQuery.data?.rows ?? [];
  const total = usersQuery.data?.total ?? 0;

  function reset() {
    setSearch('');
    setSelected(new Set());
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function toggle(userId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  function handleSubmit() {
    if (selected.size === 0) return;
    addMembers.mutate(
      { userIds: [...selected] },
      {
        onSuccess: (result) => {
          const skipped =
            result.alreadyMembers > 0 ? ` (${result.alreadyMembers} already on the team)` : '';
          toast.success(
            `${result.added} ${result.added === 1 ? 'member' : 'members'} added to ${team.name}${skipped}`,
          );
          handleOpenChange(false);
        },
        onError: (error: unknown) => {
          toast.error(error instanceof Error ? error.message : 'Could not add members');
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      trigger={<button hidden />}
      header={{
        title: `Add members - ${team.name}`,
        description: 'Telecallers and sales execs. They stay on any other team they belong to.',
      }}
      contentClassName="sm:max-w-lg"
      footer={
        <Box className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={addMembers.isPending}
            data-qa="team-add-members-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={selected.size === 0 || addMembers.isPending}
            data-qa="team-add-members-submit"
          >
            {addMembers.isPending
              ? 'Adding...'
              : selected.size === 0
                ? 'Add members'
                : `Add ${selected.size} ${selected.size === 1 ? 'member' : 'members'}`}
          </Button>
        </Box>
      }
    >
      <Box className="space-y-3">
        <Input
          value={search}
          onValueChange={setSearch}
          placeholder="Search by name or email (2+ characters)..."
          aria-label="Search staff"
          data-qa="team-add-members-search"
        />
        <Box className="max-h-80 space-y-1 overflow-y-auto pr-1" data-qa="team-add-members-list">
          {usersQuery.isLoading || teamQuery.isLoading ? (
            <Loading content="Loading staff..." />
          ) : usersQuery.isError ? (
            <TypographyP className="text-sm">Couldn&apos;t load staff.</TypographyP>
          ) : rows.length === 0 ? (
            <TypographyP className="text-muted-foreground text-sm">
              {serverSearch ? 'No staff match your search.' : 'No telecallers or sales execs found.'}
            </TypographyP>
          ) : (
            rows.map((u) => {
              const isMember = memberIds.has(u.id);
              return (
                <Box
                  key={u.id}
                  className="border-border flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                  data-qa={`team-add-member-row-${u.id}`}
                >
                  <Checkbox
                    checked={isMember || selected.has(u.id)}
                    disabled={isMember}
                    onCheckedChange={(checked) => toggle(u.id, checked)}
                    aria-label={`Add ${u.name}`}
                    label={
                      <Box as="span" className="flex flex-col">
                        <Box as="span" className="text-sm font-medium">
                          {u.name}
                        </Box>
                        <Box as="span" className="text-muted-foreground text-xs">
                          {u.email}
                        </Box>
                      </Box>
                    }
                    data-qa={`team-add-member-checkbox-${u.id}`}
                  />
                  {isMember ? (
                    <Badge variant="secondary">Already in team</Badge>
                  ) : (
                    <Badge variant="muted">{labelFor('role', u.role)}</Badge>
                  )}
                </Box>
              );
            })
          )}
          {total > rows.length ? (
            <TypographyP className="text-muted-foreground pt-1 text-xs">
              Showing {rows.length} of {total}. Search to narrow the list.
            </TypographyP>
          ) : null}
        </Box>
      </Box>
    </Dialog>
  );
}
