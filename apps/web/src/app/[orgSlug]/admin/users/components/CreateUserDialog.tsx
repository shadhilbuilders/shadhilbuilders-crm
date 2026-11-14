'use client';

// Reusable "Create user" dialog - wraps the Dialog + footer + CreateUserForm
// combo that used to be duplicated in page.tsx (once in the PageHeader
// action, once as the empty-state createTrigger for the users table). Both
// call sites open/close the SAME `createOpen` state, so only one of these
// should ever be mounted with `open=true` at a time.
import { Button, Dialog } from '@paalstack/react-ui';
import { LuPlus } from '@paalstack/react-icons/lu';
import { useId, type ReactNode } from 'react';

import { useCreateUser } from '@/hooks/queries/users';
import { CreateUserForm } from './CreateUserForm';

/**
 * A form id unique to THIS dialog instance.
 *
 * The form id lives in an attribute (`form="..."` on the footer submit
 * button), NOT in React state, so it has to be stable across re-renders -
 * `useId()` is the right tool. It matters here because the page mounts TWO
 * CreateUserDialogs that share one `open` state (the PageHeader action and
 * the table's empty-state trigger). A hardcoded id gave both instances the
 * same `form="create-user-form"`, i.e. a duplicate DOM id whenever the empty
 * state rendered - and `document.getElementById('create-user-form')` then
 * resolves to whichever one is in the page first, not necessarily the one
 * inside the open dialog.
 */
function useFormId(prefix: string): string {
  // React's useId emits colons, which are legal in an id but awkward in a
  // CSS selector; strip them so `#id` lookups stay simple.
  return `${prefix}-${useId().replace(/:/g, '')}`;
}

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
  const formId = useFormId('create-user-form');

  return (
    <Dialog
      trigger={trigger ?? <Button leftIcon={<LuPlus className="h-4 w-4" />}>Create user</Button>}
      header={{ title: 'Create a user' }}
      open={open}
      onOpenChange={onOpenChange}
      // Height cap + internal scroll: the Site Engineer variant adds a Team
      // picker, which pushed the footer's submit button BELOW the viewport on
      // short screens (measured: unreachable at 1440x440 and on a landscape
      // phone at 342px tall), so the dialog looked like it had no way to
      // create the user. Same class shape as the project dialogs.
      contentClassName="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-lg"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
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
        formId={formId}
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
