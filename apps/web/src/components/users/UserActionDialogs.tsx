'use client';

// The three user action dialogs (edit, delete, change role) that were written
// inside admin/users/page.tsx and are now needed from a second place: the
// specific-user page (/admin/users/[userId]) offers the same actions.
//
// Extracted rather than copied on purpose. The phone field carries a real
// defect history (a pre-normalized 12-digit value sat in a 10-char input and
// the first keystroke truncated it), and two copies of that logic would drift
// the moment one is fixed. The data-qa hooks are unchanged, so the existing
// page tests and any spec that drives the list keep working.
import { AlertDialog, Button, Dialog, Form, toast, TypographyStrong } from '@paalstack/react-ui';
import type { FormFieldItemType } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import z from 'zod';

import { ChangeRoleDtoSchema, UpdateUserDtoSchema } from '@shadhil/api-types';
import type { useChangeUserRole, useDeleteUser, useUpdateUser } from '@/hooks/queries/users';
import { useMemo } from 'react';
import { labelFor } from '@/lib/labels';
import type { Role } from '@/apis/client';
import { IntlPhoneInput } from '@/components/shared/IntlPhoneInput';
import {
  DEFAULT_PHONE_COUNTRY,
  OptionalPhoneInputSchema,
  PhoneCountrySchema,
  countryOfStored,
  toPhoneInputValue,
} from '@/lib/phone';

/**
 * The smallest shape both dialogs need. `UserRow` (the list) and
 * `BackendUserDetail` (the detail page) both satisfy it, so neither surface has
 * to reshape its data to reuse the dialogs.
 */
export type UserEditTarget = {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Stored canonical digits; `phoneE164` wins when the row carries both. */
  phone?: string | null;
  phoneE164?: string | null;
};

// ---------------------------------------------------------------------------
// Edit dialog - PATCH /api/users/:id (hierarchy-gated server-side)
// ---------------------------------------------------------------------------

/**
 * Form-local schema for the edit dialog.
 *
 * PHONE IS RESHAPED (2026-11-18) for the same reason as CreateUserFormSchema:
 * the wire DTO accepts `string | null` (null = CLEAR), but a text input can
 * only produce a string, so `null` cannot flow through React Hook Form.
 * `onSubmit` maps '' -> null (clear) and omits the key for CUSTOMER.
 */
const EditUserFormSchema = UpdateUserDtoSchema.omit({ phone: true, phoneCountry: true }).extend({
  // Shape-only inline (see lib/phone.ts): the country rules run server-side
  // with `phoneCountry`, which the field sets alongside the digits. OPTIONAL,
  // because a staff account is valid without a number.
  phone: OptionalPhoneInputSchema,
  phoneCountry: PhoneCountrySchema.optional(),
});
type EditUserFormValues = z.infer<typeof EditUserFormSchema>;

function EditUserDialog({
  target,
  updateUser,
  onClose,
}: {
  target: UserEditTarget | null;
  updateUser: ReturnType<typeof useUpdateUser>;
  onClose: () => void;
}) {
  const form = useForm<EditUserFormValues>({
    resolver: zodResolver(EditUserFormSchema),
    values: {
      name: target?.name ?? '',
      email: target?.email ?? '',
      // A CUSTOMER's number is derived from their lead, so the field starts
      // empty AND is disabled below - editing it here would 400.
      //
      // Canonical digits, plus the country they already belong to: the field
      // carries both, so nothing has to be guessed at submit time.
      phone:
        target === null || target.role === 'CUSTOMER'
          ? ''
          : toPhoneInputValue(target.phoneE164 ?? target.phone),
      phoneCountry: countryOfStored(target?.phoneE164 ?? target?.phone) ?? DEFAULT_PHONE_COUNTRY,
    },
    // `onTouched` so a mistyped number is flagged while the user is still in
    // the field, and cleared as soon as it parses.
    mode: 'onTouched',
  });

  function onSubmit(values: EditUserFormValues) {
    if (target === null) return;
    // '' means "clear it" for a staff user: the DTO's `null` is what erases a
    // PII value. A CUSTOMER never sends a phone at all - the service rejects
    // it, and the field is disabled anyway.
    const phone = target.role === 'CUSTOMER' ? undefined : values.phone ? values.phone : null;
    updateUser.mutate(
      {
        id: target.id,
        name: values.name,
        email: values.email,
        ...(phone === undefined ? {} : { phone }),
        // Only meaningful beside a number: a cleared field sends no country.
        ...(phone === undefined || phone === null
          ? {}
          : { phoneCountry: values.phoneCountry ?? DEFAULT_PHONE_COUNTRY }),
      },
      {
        onSuccess: () => {
          toast.success(`User ${values.name} updated`);
          onClose();
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : 'Update failed');
        },
      },
    );
  }

  const isCustomer = target?.role === 'CUSTOMER';

  const fields: FormFieldItemType<EditUserFormValues>[] = [
    {
      type: 'input',
      name: 'name',
      label: 'Name',
      required: true,
      placeholder: 'Enter name',
      inputProps: { autoComplete: 'name', 'data-qa': 'edit-user-name' },
    },
    {
      type: 'input',
      name: 'email',
      label: 'Email',
      required: true,
      placeholder: 'name@shadhilbuilders.in',
      inputProps: { autoComplete: 'email', 'data-qa': 'edit-user-email' },
    },
    {
      type: 'custom',
      name: 'phone',
      label: 'Phone',
      // Not required: a staff account is valid without a number, and only the
      // (unbuilt) telephony provisioning actually needs one.
      description: isCustomer
        ? 'This buyer has no phone of their own - update it on their lead.'
        : undefined,
      render: ({ field, fieldState }) => (
        <IntlPhoneInput
          aria-invalid={fieldState.invalid}
          id={field.name}
          name={field.name}
          value={field.value ?? ''}
          onBlur={field.onBlur}
          disabled={isCustomer}
          defaultCountry={DEFAULT_PHONE_COUNTRY}
          onChange={(digits, country) => {
            field.onChange(digits);
            form.setValue('phoneCountry', country ?? DEFAULT_PHONE_COUNTRY);
          }}
          placeholder={isCustomer ? '-' : '9876543210'}
          data-qa="edit-user-phone"
        />
      ),
    },
  ];

  return (
    <Dialog
      trigger={null}
      header={{ title: `Edit ${target?.name ?? 'user'}` }}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      contentClassName="sm:max-w-lg"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="edit-user-form"
            isLoading={updateUser.isPending}
            loadingText="Saving..."
            data-qa="edit-user-submit"
          >
            Save changes
          </Button>
        </div>
      }
    >
      <Form
        id="edit-user-form"
        form={form}
        onSubmit={onSubmit}
        hideSubmitButton
        hideResetButton
        fields={fields}
      />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete dialog - DELETE /api/users/:id (hierarchy-gated server-side)
// ---------------------------------------------------------------------------

function DeleteUserDialog({
  target,
  deleteUser,
  onClose,
  onDeleted,
}: {
  target: UserEditTarget | null;
  deleteUser: ReturnType<typeof useDeleteUser>;
  onClose: () => void;
  /**
   * Fired only on a successful delete, before `onClose`. The list page just
   * closes the dialog; the detail page has to navigate away, because the row it
   * is showing no longer resolves and the panel would fall into its error
   * branch with a 404 toast it never asked for.
   */
  onDeleted?: () => void;
}) {
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      trigger={null}
      header={{
        title: `Delete ${target?.name ?? 'user'}?`,
        description:
          'This soft-deletes the user: they can no longer sign in and are hidden from every list. Their account is kept (not permanently erased).',
      }}
      cancelButtonText="Cancel"
      confirmButtonText={deleteUser.isPending ? 'Deleting...' : 'Delete user'}
      confirmButtonProps={{
        variant: 'destructive',
        disabled: deleteUser.isPending,
      }}
      onConfirm={() => {
        if (target === null) return;
        deleteUser.mutate(target.id, {
          onSuccess: () => {
            toast.success(`User ${target.name} soft-deleted`);
            onDeleted?.();
            onClose();
          },
          onError: (error) => {
            toast.error(error instanceof Error ? error.message : 'Delete failed');
          },
        });
      }}
      onCancel={onClose}
    />
  );
}

// ---------------------------------------------------------------------------
// Change-role dialog - explicit approval before the critical role change
// ---------------------------------------------------------------------------

type ChangeRoleFormValues = z.infer<typeof ChangeRoleDtoSchema>;

function ChangeRoleDialog({
  target,
  assignableRoles,
  changeRole,
  onClose,
}: {
  target: UserEditTarget | null;
  assignableRoles: string[];
  changeRole: ReturnType<typeof useChangeUserRole>;
  onClose: () => void;
}) {
  const form = useForm<ChangeRoleFormValues>({
    resolver: zodResolver(ChangeRoleDtoSchema),
    values: {
      role: target?.role ?? 'TELECALLER',
    },
    mode: 'onSubmit',
  });

  const options = useMemo(() => {
    if (target === null) return [];
    return [
      { value: target.role, label: labelFor('role', target.role) },
      ...assignableRoles
        .filter((r) => r !== target.role)
        .map((r) => ({ value: r, label: labelFor('role', r) })),
    ];
  }, [target, assignableRoles]);

  function onSubmit(values: ChangeRoleFormValues) {
    if (target === null) return;
    // Same-role submit is a no-op - surface it so the user knows the
    // change didn't apply (autoplan 2026-09-09).
    if (values.role === target.role) {
      toast.error(
        `${target.name} is already a ${labelFor('role', values.role)}. Choose a different role to change it.`,
      );
      return;
    }
    changeRole.mutate(
      { id: target.id, role: values.role },
      {
        onSuccess: () => {
          toast.success(`Role changed to ${labelFor('role', values.role)}`);
          onClose();
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : 'Role change failed');
        },
      },
    );
  }

  const fields: FormFieldItemType<ChangeRoleFormValues>[] = [
    {
      type: 'select',
      name: 'role',
      label: 'New role',
      required: true,
      options,
      selectProps: { 'data-qa': 'change-role-select' },
    },
  ];

  return (
    <Dialog
      trigger={null}
      header={{
        title: `Change role for ${target?.name ?? 'user'}`,
        description:
          target === null ? undefined : (
            <>
              Current role: <TypographyStrong>{labelFor('role', target.role)}</TypographyStrong>.
              Permissions take effect as soon as you confirm.
            </>
          ),
      }}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      contentClassName="sm:max-w-lg"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="change-role-form"
            isLoading={changeRole.isPending}
            loadingText="Changing..."
            data-qa="change-role-confirm"
          >
            Change role
          </Button>
        </div>
      }
    >
      <Form
        id="change-role-form"
        form={form}
        onSubmit={onSubmit}
        hideSubmitButton
        hideResetButton
        fields={fields}
      />
    </Dialog>
  );
}

export { ChangeRoleDialog, DeleteUserDialog, EditUserDialog };
