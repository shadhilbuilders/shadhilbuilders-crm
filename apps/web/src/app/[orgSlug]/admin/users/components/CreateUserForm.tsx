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
import { IntlPhoneInput } from '@/components/shared/IntlPhoneInput';
import { labelFor } from '@/lib/labels';
import { DEFAULT_PHONE_COUNTRY, PhoneCountrySchema, OptionalPhoneInputSchema } from '@/lib/phone';
import type { CountryCode } from '@shadhil/api-types/phone';
import { CustomerLeadField } from './CustomerLeadField';

/** Roles that cannot exist without a team (the service rejects them without
 *  one). MANAGER auto-creates its own team, so it is deliberately absent. */
const ROLES_REQUIRING_TEAM: readonly Role[] = ['TELECALLER', 'SALES_EXEC', 'ENGINEER'];

/** Issue #8 slice 2: a CUSTOMER login must point at a Lead (and belongs to no
 *  team). Mirrors UsersService.create, which requires customerLeadId for
 *  CUSTOMER and rejects it for every other role. */
const ROLES_REQUIRING_LEAD: readonly Role[] = ['CUSTOMER'];

function roleNeedsLead(role: Role | undefined): boolean {
  return role !== undefined && ROLES_REQUIRING_LEAD.includes(role);
}

function roleNeedsTeam(role: Role | undefined): boolean {
  return role !== undefined && ROLES_REQUIRING_TEAM.includes(role);
}

/**
 * The form-local schema: the shared DTO contract PLUS the "team is required
 * for staff roles" rule.
 *
 * PHONE IS RESHAPED HERE (2026-11-18). On the wire `phone` is the clearable
 * union (`PhoneSchema | null`), but a text input can only ever produce a
 * string, so carrying `null` into React Hook Form makes `value` unrenderable.
 * The form therefore validates a plain string and `onSubmit` maps:
 *   ''   -> undefined (create) / null (update, i.e. CLEAR)
 *   '98…' -> the string, normalized by the DTO on the server
 * `phone` is omitted entirely for CUSTOMER, whose number lives on their lead.
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
const CreateUserFormSchema = CreateUserDtoSchema.omit({ phone: true, phoneCountry: true })
  // Validated inline (2026-11-19): a bare `z.string().optional()` let a
  // mistyped number through to the API, which rejected it as a toast. The rule
  // is shape-only now - the country rules run server-side with `phoneCountry`.
  // OPTIONAL, because a staff account is valid without a number.
  .extend({
    phone: OptionalPhoneInputSchema,
    phoneCountry: PhoneCountrySchema.optional(),
  })
  .superRefine((values, ctx) => {
    if (roleNeedsTeam(values.role) && !values.teamId) {
      ctx.addIssue({
        code: 'custom',
        path: ['teamId'],
        message: 'Select a team for this user',
      });
    }
    if (roleNeedsLead(values.role) && !values.customerLeadId) {
      ctx.addIssue({
        code: 'custom',
        path: ['customerLeadId'],
        message: 'Select the lead this customer belongs to',
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
      phone: '',
      phoneCountry: DEFAULT_PHONE_COUNTRY,
    },
    // `onSubmit`, the house rule: a mistyped number is caught on the first Save
    // and cleared as soon as it parses. The team/customer-lead refinements above
    // share this, so their messages also appear at submit rather than on blur.
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
      customerLeadId?: string;
      phone?: string;
      phoneCountry?: CountryCode;
    } = {
      name: values.name,
      email: values.email,
      password: values.password,
      role: values.role,
    };
    // 2026-11-18: staff contact number. Deliberately NOT sent for CUSTOMER - a
    // buyer's number lives on their lead, and the server rejects it here. Sent
    // only when the user actually typed one (empty string would be a 400).
    if (!roleNeedsLead(values.role) && values.phone) {
      payload.phone = values.phone;
      // The digits only mean one number beside the country they were typed in.
      payload.phoneCountry = values.phoneCountry;
    }
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
    // Customers carry a lead pointer instead of a team; the schema above
    // already rejected a missing one, this keeps the payload honest.
    if (roleNeedsLead(values.role) && values.customerLeadId) {
      payload.customerLeadId = values.customerLeadId;
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

  // 2026-11-18: staff phone. Optional. Deliberately NOT shown for CUSTOMER -
  // that role's number belongs to their lead, and the server rejects a phone
  // on a customer create. Keyed on `selectedRole` so it disappears the moment
  // the role picker switches to CUSTOMER.
  if (!roleNeedsLead(selectedRole)) {
    fields.push({
      type: 'custom',
      name: 'phone',
      label: 'Phone',
      description: 'Optional.',
      render: ({ field, fieldState }) => (
        <IntlPhoneInput
          aria-invalid={fieldState.invalid}
          id={field.name}
          name={field.name}
          value={field.value ?? ''}
          onBlur={field.onBlur}
          defaultCountry={DEFAULT_PHONE_COUNTRY}
          onChange={(digits, country) => {
            field.onChange(digits);
            form.setValue('phoneCountry', country ?? DEFAULT_PHONE_COUNTRY);
          }}
          placeholder="9876543210"
          data-qa="create-user-phone"
        />
      ),
    });
  }

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
        // `isInvalid` only marks the control (aria-invalid + red border). The
        // MESSAGE is rendered once by react-ui's Form (`form-error-message-
        // <name>`) for every non-`field` item, so passing `errorMessage` here
        // as well printed the same sentence twice under the picker.
        <Combobox
          {...field}
          value={field.value ?? ''}
          options={teams.map((team) => ({ value: team.id, label: team.name }))}
          placeholder={teamsLoading ? 'Loading teams...' : 'Search and select a team...'}
          data-qa="create-user-team"
          isInvalid={fieldState.invalid}
          onValueChange={(value) => {
            field.onChange(value ?? undefined);
          }}
        />
      ),
    });
  }

  if (roleNeedsLead(selectedRole)) {
    fields.push({
      type: 'custom',
      name: 'customerLeadId',
      label: 'Customer (lead)',
      required: true,
      render: ({ field, fieldState }) => (
        <CustomerLeadField
          value={field.value}
          onChange={field.onChange}
          isInvalid={fieldState.invalid}
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
