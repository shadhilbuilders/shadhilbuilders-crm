'use client';

// Reusable "Create user" dialog - wraps the Dialog + footer + CreateUserForm
// combo that used to be duplicated in page.tsx (once in the PageHeader
// action, once as the empty-state createTrigger for the users table). Both
// call sites open/close the SAME `createOpen` state, so only one of these
// should ever be mounted with `open=true` at a time.
import { Button, Dialog } from '@paalstack/react-ui';
import { LuPlus } from '@paalstack/react-icons/lu';
import type { ReactNode } from 'react';

import { useCreateUser } from '@/hooks/queries/users';
import { CreateUserForm } from './CreateUserForm';

export function CreateUserDialog({
  open,
  onOpenChange,
  creatableRoles,
  createUser,
  showTeamField,
  teams,
  teamsLoading,
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creatableRoles: string[];
  createUser: ReturnType<typeof useCreateUser>;
  showTeamField: boolean;
  teams: { id: string; name: string }[];
  teamsLoading: boolean;
  /** Defaults to the standard "Create user" button. */
  trigger?: ReactNode;
}) {
  return (
    <Dialog
      trigger={
        trigger ?? (
          <Button leftIcon={<LuPlus className="h-4 w-4" />}>
            Create user
          </Button>
        )
      }
      header={{ title: 'Create a user' }}
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="sm:max-w-md"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="create-user-form"
            isLoading={createUser.isPending}
            loadingText="Creating..."
            data-qa="create-user-submit"
          >
            Create user
          </Button>
        </div>
      }
    >
      <CreateUserForm
        creatableRoles={creatableRoles}
        createUser={createUser}
        onDone={() => onOpenChange(false)}
        showTeamField={showTeamField}
        teams={teams}
        teamsLoading={teamsLoading}
      />
    </Dialog>
  );
}
