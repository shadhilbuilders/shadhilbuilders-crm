'use client';

// ResetPasswordDialog - ADMIN/OWNER sets a new password for another user.
// Shared by /admin/users (row action) and /admin/staff-permission (detail
// panel). Authorization is enforced server-side (actor must strictly outrank
// the target); callers only decide when to offer the action.
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import { Button, Dialog, Form, toast } from '@paalstack/react-ui';
import type { FormFieldItemType } from '@paalstack/react-ui';
import {
  AdminResetPasswordFormSchema,
  type AdminResetPasswordFormValues,
} from '@shadhil/api-types';

import { useResetUserPassword } from '@/hooks/queries/users';
import { PasswordInput } from '@/components/shared/PasswordInput';

export type ResetPasswordTarget = { id: string; name: string };

const EMPTY: AdminResetPasswordFormValues = {
  newPassword: '',
  confirmPassword: '',
};

export function ResetPasswordDialog({
  target,
  onClose,
}: {
  target: ResetPasswordTarget | null;
  onClose: () => void;
}) {
  const resetPassword = useResetUserPassword();
  const form = useForm<AdminResetPasswordFormValues>({
    resolver: zodResolver(AdminResetPasswordFormSchema),
    defaultValues: EMPTY,
    mode: 'onSubmit',
  });

  function close() {
    form.reset(EMPTY);
    onClose();
  }

  function onSubmit(values: AdminResetPasswordFormValues) {
    if (target === null) return;
    resetPassword.mutate(
      { id: target.id, newPassword: values.newPassword },
      {
        onSuccess: () => {
          toast.success(`Password changed for ${target.name}`);
          close();
        },
        onError: (error) => {
          toast.error(
            error instanceof Error ? error.message : 'Password change failed',
          );
        },
      },
    );
  }

  const fields: FormFieldItemType<AdminResetPasswordFormValues>[] = [
    {
      type: 'custom',
      name: 'newPassword',
      label: 'New password',
      required: true,
      render: ({ field }) => (
        <PasswordInput
          {...field}
          autoComplete="new-password"
          placeholder="At least 8 characters"
          maxLength={200}
          className="w-full text-sm"
          data-qa="reset-password-new"
        />
      ),
    },
    {
      type: 'custom',
      name: 'confirmPassword',
      label: 'Confirm new password',
      required: true,
      render: ({ field }) => (
        <PasswordInput
          {...field}
          autoComplete="new-password"
          placeholder="Re-enter the new password"
          maxLength={200}
          className="w-full text-sm"
          data-qa="reset-password-confirm"
        />
      ),
    },
  ];

  return (
    <Dialog
      trigger={null}
      header={{
        title: `Change password for ${target?.name ?? 'user'}`,
        description:
          'Set a new password. Share it with the user securely - this action is audited.',
      }}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      contentClassName="sm:max-w-lg"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="reset-password-form"
            isLoading={resetPassword.isPending}
            loadingText="Changing..."
            data-qa="reset-password-confirm-button"
          >
            Change password
          </Button>
        </div>
      }
    >
      <Form
        id="reset-password-form"
        form={form}
        onSubmit={onSubmit}
        hideSubmitButton
        hideResetButton
        fields={fields}
      />
    </Dialog>
  );
}
