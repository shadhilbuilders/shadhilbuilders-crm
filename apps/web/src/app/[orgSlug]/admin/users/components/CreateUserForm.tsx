'use client';

// Create form - posts to POST /api/users (server enforces the hierarchy).
//
// Client-side validation IS the server contract: CreateUserDtoSchema in
// packages/api-types/src/auth.ts (name/email/password rules + role enum).
// The server re-validates the same shape and surfaces errors verbatim via
// toast. teamId is optional on the wire but the service REQUIRES it when
// role is TELECALLER/SALES_EXEC/ENGINEER (an admin creating staff without
// a team = "teamId is required"). The dialog shows the Team field only for
// staff roles.
import { Combobox, Form, toast } from '@paalstack/react-ui';
import type { FormFieldItemType } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import z from 'zod';

import { CreateUserDtoSchema } from '@shadhil/api-types';
import { useCreateUser } from '@/hooks/queries/users';
import type { Role } from '@/apis/client';
import { PasswordInput } from '@/components/shared/PasswordInput';
import { labelFor } from '@/lib/labels';

/** Roles that cannot exist without a team (the service rejects them without
 *  one). MANAGER auto-creates its own team, so it is deliberately absent. */
const ROLES_REQUIRING_TEAM: readonly Role[] = ['TELECALLER', 'SALES_EXEC', 'ENGINEER'];

function roleNeedsTeam(role: Role | undefined): boolean {
  return role !== undefined && ROLES_REQUIRING_TEAM.includes(role);
}

/**
 * The form-local schema: the shared DTO contract PLUS the "team is required
 * for staff roles" rule.
 *
 * This rule used to live only in `onSubmit` as a `toast.error(...)` early
 * return, which put the message in a transient toast far from the field and
 * left the Team picker itself unmarked - so the dialog looked like it had
 * simply ignored the click. Expressing it as a schema refinement instead makes
 * it a normal field error: the resolver rejects the submit before onSubmit
 * runs, the Combobox below renders the message inline, and RHF's
 * reValidateMode ('onChange', the default) clears it the moment a team is
 * picked or the role changes back to one that needs no team.
 *
 * Deliberately a REFINEMENT rather than a conditional field schema: the
 * error must land on `teamId`, which only exists while a staff role is
 * selected.
 */
const CreateUserFormSchema = CreateUserDtoSchema.superRefine((values, ctx) => {
  if (roleNeedsTeam(values.role) && !values.teamId) {
    ctx.addIssue({
      code: 'custom',
      path: ['teamId'],
      message: 'Select a team for this user',
    });
  }
});

export { CreateUserFormSchema };

export type CreateUserFormValues = z.infer<typeof CreateUserFormSchema>;

export function CreateUserForm({
  formId,
  creatableRoles,
  createUser,
  onDone,
  showTeamField,
  teams,
  teamsLoading,
}: {
  /** Unique form id - the dialog's footer submit button targets it via `form=`. */
  formId: string;
  creatableRoles: string[];
  createUser: ReturnType<typeof useCreateUser>;
  onDone: () => void;
  showTeamField: boolean;
  teams: { id: string; name: string }[];
  teamsLoading: boolean;
}) {
  const form = useForm<CreateUserFormValues>({
    // cast: react-hook-form infers its input/output generics from the
    // superRefine'd schema, which is the same runtime shape as the DTO.
    resolver: zodResolver(CreateUserFormSchema) as never,
    defaultValues: {
      name: '',
      email: '',
      password: '',
      role: (creatableRoles[0] as Role | undefined) ?? 'TELECALLER',
    },
    mode: 'onSubmit',
  });

  // Watch the role so the Team field appears only for staff (and a MANAGER
  // being created auto-creates its own team, so no team picker needed).
  const selectedRole = form.watch('role');

  // RHF's handleSubmit drops invalid submissions silently and the react-ui
  // Form renders no per-field error text, so a blocked submit (bad email,
  // short password, empty name) used to look like a dead button: click,
  // nothing happens, no message anywhere. That was fixed by moving the
  // team-required rule into `CreateUserFormSchema` above, which makes every
  // failure a normal field error the fields render inline. The old
  // `fieldErrors` summary that read `form.formState.errors` here was left
  // behind by that refactor with no render site - it is gone.

  function onSubmit(values: CreateUserFormValues) {
    // The payload is CreateUserDto-shaped. teamId is sent only when a staff
    // user is being created (the field is present) - the server auto-creates
    // a team for MANAGER and requires one for TELECALLER/SALES_EXEC/ENGINEER.
    const payload: {
      name: string;
      email: string;
      password: string;
      role: Role;
      teamId?: string;
    } = {
      name: values.name,
      email: values.email,
      password: values.password,
      role: values.role,
    };
    // The missing-team case is already rejected by CreateUserFormSchema, which
    // is what renders the inline error under the Team picker. This guard only
    // catches a submit that bypassed the resolver (e.g. a direct
    // handleSubmit call from a future caller).
    if (roleNeedsTeam(values.role)) {
      if (!values.teamId) {
        form.setError('teamId', { message: 'Select a team for this user' });
        return;
      }
      payload.teamId = values.teamId;
    }
    createUser.mutate(payload, {
      onSuccess: () => {
        toast.success(`User ${values.name} created`);
        onDone();
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : 'Create failed');
      },
    });
  }

  const fields: FormFieldItemType<CreateUserFormValues>[] = [
    {
      type: 'input',
      name: 'name',
      label: 'Name',
      required: true,
      placeholder: 'Enter name',
      inputProps: {
        autoComplete: 'name',
        'data-qa': 'create-user-name',
      },
    },
    {
      type: 'input',
      name: 'email',
      label: 'Email',
      required: true,
      inputType: 'email',
      placeholder: 'name@shadhilbuilders.in',
      inputProps: {
        autoComplete: 'email',
        'data-qa': 'create-user-email',
      },
    },
    {
      type: 'custom',
      name: 'password',
      label: 'Temporary password',
      required: true,
      render: ({ field }) => (
        <PasswordInput
          {...field}
          autoComplete="new-password"
          placeholder="Minimum 8 characters"
          maxLength={200}
          className="min-h-11 w-full text-sm"
          data-qa="create-user-password"
        />
      ),
    },
    {
      type: 'select',
      name: 'role',
      label: 'Role',
      required: true,
      options: creatableRoles.map((value) => ({
        value,
        label: labelFor('role', value),
      })),
      selectProps: { 'data-qa': 'create-user-role' },
    },
  ];

  // Team field - shown only when creating a STAFF user (TELECALLER/SALES_EXEC)
  // so the user is linked to a team. The backend rejects staff users without
  // a teamId; MANAGER auto-creates a team and ADMIN/OWNER users aren't
  // created with a team here.
  if (showTeamField && roleNeedsTeam(selectedRole)) {
    fields.push({
      type: 'custom',
      name: 'teamId',
      label: 'Team',
      required: true,
      render: ({ field, fieldState }) => (
        // `isInvalid` + `errorMessage` make the Combobox render the message
        // INLINE under the picker (react-ui's Combobox shows
        // ErrorMessage when isInvalid, and marks the control aria-invalid).
        // Passing them is what replaces the old "Please select a team" toast:
        // the error now sits next to the field it is about, and clears itself
        // as soon as a team is chosen.
        <Combobox
          {...field}
          value={field.value ?? ''}
          options={teams.map((team) => ({ value: team.id, label: team.name }))}
          placeholder={teamsLoading ? 'Loading teams...' : 'Search and select a team...'}
          data-qa="create-user-team"
          selectOptionAsValue
          isInvalid={fieldState.invalid}
          onValueChange={(value) => {
            field.onChange(value ?? undefined);
          }}
        />
      ),
    });
  }

  return (
      <Form
        id={formId}
        form={form}
        onSubmit={onSubmit}
        hideSubmitButton
        hideResetButton
        fields={fields}
      />
  );
}
