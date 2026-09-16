'use client';

// Create form - posts to POST /api/users (server enforces the hierarchy).
//
// Client-side validation IS the server contract: CreateUserDtoSchema in
// packages/api-types/src/auth.ts (name/email/password rules + role enum).
// The server re-validates the same shape and surfaces errors verbatim via
// toast. teamId is optional in the schema but the service REQUIRES it when
// role is TELECALLER/SALES_EXEC (an admin creating staff without a team =
// "teamId is required"). The dialog shows the Team field only for staff
// roles.
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

export type CreateUserFormValues = z.infer<typeof CreateUserDtoSchema>;

export function CreateUserForm({
  creatableRoles,
  createUser,
  onDone,
  showTeamField,
  teams,
  teamsLoading,
}: {
  creatableRoles: string[];
  createUser: ReturnType<typeof useCreateUser>;
  onDone: () => void;
  showTeamField: boolean;
  teams: { id: string; name: string }[];
  teamsLoading: boolean;
}) {
  const form = useForm<CreateUserFormValues>({
    resolver: zodResolver(CreateUserDtoSchema),
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

  function onSubmit(values: CreateUserFormValues) {
    // The payload is CreateUserDto-shaped. teamId is sent only when a staff
    // user is being created (the field is present) - the server auto-creates
    // a team for MANAGER and requires one for TELECALLER/SALES_EXEC.
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
    const needsTeam = values.role === 'TELECALLER' || values.role === 'SALES_EXEC';
    if (needsTeam) {
      if (!values.teamId) {
        toast.error('Please select a team for this user.');
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
  const isStaffRole =
    selectedRole === 'TELECALLER' || selectedRole === 'SALES_EXEC';
  if (showTeamField && isStaffRole) {
    fields.push({
      type: 'custom',
      name: 'teamId',
      label: 'Team',
      required: true,
      render: ({ field }) => (
        <Combobox
          {...field}
          value={field.value ?? ''}
          options={teams.map((team) => ({ value: team.id, label: team.name }))}
          placeholder={teamsLoading ? 'Loading teams...' : 'Search and select a team...'}
          data-qa="create-user-team"
          selectOptionAsValue
          onValueChange={(value) => {
            field.onChange(value ?? undefined);
          }}
        />
      ),
    });
  }

  return (
    <Form
      id="create-user-form"
      form={form}
      onSubmit={onSubmit}
      hideSubmitButton
      hideResetButton
      fields={fields}
    />
  );
}
