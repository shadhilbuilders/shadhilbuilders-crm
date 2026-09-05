'use client';

// /change-password — T-S hardening (Week 5, 2026-09-04).
//
// Self-service password rotation page. Reached two ways:
//   1. User is redirected here after sign-in if the API returns
//      403 + PASSWORD_CHANGE_REQUIRED (the seed users — owner /
//      admin / manager / telecaller / sales_exec — all have
//      mustChangePassword: true).
//   2. Direct navigation (change-password bounce / menu).
//
// ALIGNMENT (2026-09-05): the form lives inside a centered Card on a
// full-height flex main — same visual language as /login. The
// previous dashboard-style PageHeader + full-width Form hugged the
// left edge and stretched inputs across the viewport (screenshot
// reported by user).
//
// Posts to /api/users/:id/change-password (T-S backend endpoint).
// On success, the API flips the user's mustChangePassword flag to
// false and writes an audit row, so the next guarded request passes
// the auth guard normally.
//
// Form uses the props-API <Form> from @paalstack/react-ui. Validation
// lives in onSubmit (the Form component doesn't accept react-hook-form
// `rules`; client-side checks happen in JS). NOTE: the library's Form
// spreads resetButtonProps BEFORE `children: resetText`, so a
// `children` override in resetButtonProps is silently clobbered —
// button text goes through `resetText` (verified in dist source).
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';

import { Card, Form, Heading, toast } from '@paalstack/react-ui';

import { api } from '@/apis/client';
import { useSessionUser } from '@/lib/session';

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
      <main className="text-ink flex min-h-[calc(100vh-4rem)] items-center justify-center px-4">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
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
    <main className="text-ink flex min-h-[calc(100vh-4rem)] items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Heading className="mb-1">Change password</Heading>
          <p className="text-muted-foreground text-sm">
            Set a new password for your account.
          </p>
        </div>

        <Form
          form={form}
          onSubmit={onSubmit}
          submitText="Change password"
          submitButtonProps={{ type: 'submit' }}
          resetText="Cancel"
          resetButtonProps={{
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

        <p className="text-muted-foreground mt-6 text-center text-xs">
          Shadhil Builders internal system — access is provisioned by an admin.
        </p>
      </Card>
    </main>
  );
}