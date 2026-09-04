'use client';

// /change-password — T-S hardening (Week 5, 2026-09-04).
//
// Self-service password rotation page. Reached two ways:
//   1. User is redirected here after sign-in if the API returns
//      403 + PASSWORD_CHANGE_REQUIRED (the seed users — owner /
//      admin / manager / telecaller / sales_exec — all have
//      mustChangePassword: true).
//   2. Direct navigation from the user menu (Week 6+ when the
//      user-management UI ships; for now only the redirect path
//      uses this).
//
// Posts to /api/users/:id/change-password (T-S backend endpoint).
// On success, the API flips the user's mustChangePassword flag to
// false and writes an audit row, so the next guarded request
// passes the auth guard normally.
//
// Form uses the props-API <Form> from @paalstack/react-ui per the
// canonical pattern in apps/web/src/app/(app)/leads/new/page.tsx.
// Validation lives in onSubmit (the Form component doesn't accept
// react-hook-form `rules`; client-side checks happen in JS).
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';

import { Form, toast } from '@paalstack/react-ui';

import { api } from '@/apis/client';
import { useSessionUser } from '@/lib/session';

import { PageHeader } from '../(app)/PageHeader';

type FormValues = {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
};

type ChangePasswordResponse = { ok: true; mustChangePassword: false };

export default function ChangePasswordPage() {
  const router = useRouter();
  const { user, isPending: sessionPending } = useSessionUser();
  const form = useForm<FormValues>({
    defaultValues: { oldPassword: '', newPassword: '', confirmPassword: '' },
    mode: 'onSubmit',
  });

  if (sessionPending) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Change password"
          breadcrumb={[{ label: 'Change password' }]}
        />
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    );
  }
  if (user === null) {
    if (typeof window !== 'undefined') {
      window.location.href = `/login?next=${encodeURIComponent('/change-password')}`;
    }
    return null;
  }

  function onSubmit(values: FormValues) {
    if (values.newPassword !== values.confirmPassword) {
      toast.error('New password and confirmation do not match');
      return;
    }
    if (values.newPassword.length < 8) {
      toast.error('New password must be at least 8 characters');
      return;
    }
    void api<ChangePasswordResponse>(
      `/users/${user!.id}/change-password`,
      {
        method: 'POST',
        json: {
          oldPassword: values.oldPassword,
          newPassword: values.newPassword,
        },
      },
    ).then(
      () => {
        toast.success('Password changed');
        void router.replace('/');
        void router.refresh();
      },
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Password change failed';
        toast.error(msg);
      },
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Change password"
        subtitle="Set a new password for your account."
        breadcrumb={[{ label: 'Change password' }]}
      />

      <Form
        form={form}
        onSubmit={onSubmit}
        submitText="Change password"
        submitButtonProps={{ type: 'submit' }}
        resetButtonProps={{
          children: 'Cancel',
          onClick: () => {
            form.reset();
            void router.push('/');
          },
        }}
        fields={[
          {
            type: 'input',
            name: 'oldPassword',
            label: 'Current password',
            placeholder: 'Enter your current password',
            required: true,
            inputProps: {
              type: 'password',
              autoComplete: 'current-password',
              'data-qa': 'change-password-old',
              maxLength: 200,
            },
          },
          {
            type: 'input',
            name: 'newPassword',
            label: 'New password',
            placeholder: 'At least 8 characters',
            required: true,
            inputProps: {
              type: 'password',
              autoComplete: 'new-password',
              'data-qa': 'change-password-new',
              maxLength: 200,
            },
          },
          {
            type: 'input',
            name: 'confirmPassword',
            label: 'Confirm new password',
            placeholder: 'Re-enter the new password',
            required: true,
            inputProps: {
              type: 'password',
              autoComplete: 'new-password',
              'data-qa': 'change-password-confirm',
              maxLength: 200,
            },
          },
        ]}
      />
    </div>
  );
}
