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
// is declarative zod via zodResolver — the schema is
// ChangePasswordFormSchema from @shadhil/api-types, which EXTENDS the
// server's ChangePasswordDtoSchema, so client and server rules can't
// drift. The Form's FieldError renders each field's message inline.
// NOTE: the library's Form spreads resetButtonProps BEFORE
// `children: resetText`, so a `children` override in resetButtonProps
// is silently clobbered — button text goes through `resetText`
// (verified in dist source).
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';

import {
  ChangePasswordFormSchema,
  type ChangePasswordFormValues,
} from '@shadhil/api-types';
import { Card, Form, Heading, toast } from '@paalstack/react-ui';

import { AuthTopBar } from '@/components/auth-top-bar';
import { PasswordInput } from '@/components/shared/PasswordInput';
import { Skeleton } from '@/components/shared/Skeleton';
import { api } from '@/apis/client';
import { useSessionUser } from '@/lib/session';

type ChangePasswordResponse = { ok: true; mustChangePassword: false };

export default function ChangePasswordPage() {
  const router = useRouter();
  const { user, isPending: sessionPending } = useSessionUser();
  const form = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(ChangePasswordFormSchema),
    defaultValues: { oldPassword: '', newPassword: '', confirmPassword: '' },
    mode: 'onSubmit',
  });

  if (sessionPending) {
    return (
      <div className="bg-background flex min-h-[100dvh] flex-col">
        <AuthTopBar />
        <main className="text-ink flex flex-1 items-center justify-center px-4 py-8">
          {/* Card-shaped skeleton mirroring the real form below it —
              the swap from pending → form doesn't shift layout. */}
          <div
            role="status"
            aria-busy="true"
            aria-live="polite"
            aria-label="Loading change password"
            data-qa="change-password-skeleton"
            className="w-full max-w-md space-y-4 rounded-lg border p-6"
          >
            <div className="mb-6 space-y-2 text-center">
              <Skeleton variant="text" count={1} className="mx-auto [&>div]:h-6 [&>div]:w-44" />
              <Skeleton variant="text" count={1} className="mx-auto [&>div]:h-4 [&>div]:w-64" />
            </div>
            <Skeleton variant="text" count={1} className="[&>div]:h-4 [&>div]:w-32" />
            <Skeleton variant="card" className="[&>div]:h-11 [&>div]:rounded-md" />
            <Skeleton variant="text" count={1} className="[&>div]:h-4 [&>div]:w-28" />
            <Skeleton variant="card" className="[&>div]:h-11 [&>div]:rounded-md" />
            <Skeleton variant="text" count={1} className="[&>div]:h-4 [&>div]:w-40" />
            <Skeleton variant="card" className="[&>div]:h-11 [&>div]:rounded-md" />
            <div className="flex gap-3 pt-2">
              <Skeleton variant="card" className="[&>div]:h-9 [&>div]:w-20 [&>div]:rounded-md" />
              <Skeleton variant="card" className="[&>div]:h-9 [&>div]:w-40 [&>div]:rounded-md" />
            </div>
          </div>
        </main>
      </div>
    );
  }
  if (user === null) {
    if (typeof window !== 'undefined') {
      window.location.href = `/login?next=${encodeURIComponent('/change-password')}`;
    }
    return null;
  }

  function onSubmit(values: ChangePasswordFormValues) {
    // Validation is zod (zodResolver): required fields, min lengths,
    // and the cross-field match rule are all enforced BEFORE onSubmit
    // runs — the inline FieldError messages render under each input.
    // Keep the length guard as defense-in-depth; the API call body is
    // ChangePasswordDto-shaped (confirmPassword is client-only).
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
    <div className="bg-background flex min-h-[100dvh] flex-col">
      <AuthTopBar />
      <main className="text-ink flex flex-1 items-center justify-center px-4 py-8">
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
                type: 'custom',
                name: 'oldPassword',
                label: 'Current password',
                required: true,
                render: ({ field }) => (
                  <PasswordInput
                    {...field}
                    autoComplete="current-password"
                    placeholder="Enter your current password"
                    maxLength={200}
                    className="min-h-11 w-full text-sm"
                    data-qa="change-password-old"
                  />
                ),
              },
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
                    className="min-h-11 w-full text-sm"
                    data-qa="change-password-new"
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
                    className="min-h-11 w-full text-sm"
                    data-qa="change-password-confirm"
                  />
                ),
              },
            ]}
          />

          <p className="text-muted-foreground mt-6 text-center text-xs">
            Shadhil Builders internal system — access is provisioned by an admin.
          </p>
        </Card>
      </main>
    </div>
  );
}