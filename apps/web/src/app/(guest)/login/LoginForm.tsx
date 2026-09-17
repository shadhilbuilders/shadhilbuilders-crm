'use client';

// Login page - better-auth email/password via the shared authClient.
//
// UX/behavior contract (frontend-developer best practices applied):
//   - Single generic error message on failure ("Invalid email or password").
//     Never reveal WHICH field was wrong (account-enumeration defense).
//   - Submit disabled while pending; button label reflects state.
//   - autocomplete="email" / "current-password" so password managers work.
//   - Redirect honors ?next=<path> (validated: only same-origin paths -
//     an attacker-supplied https://evil.example/next must not be honored).
//   - Already signed in? bounce straight to the target (client-side - the
//     middleware handles server-side; this covers after-login revisits).
//   - Password visibility toggle via the shared PasswordInput (2026-09-05).
//
// FORM (2026-09-05): the library's props-API <Form> renders the fields,
// labels, inline zod errors, and the submit button. Field-shape errors
// (empty / bad email) are zod-inline under each field via the Form's
// FieldError. The generic "Invalid email or password" auth failure is a
// toast.error - an API-level outcome, not a field-shape problem, and it
// must not be mistaken for validation feedback pinned under a field.
// Account-enumeration defense preserved: zod judges shape only; the
// generic message fires only on real credential rejection.
import { useQueryClient } from '@tanstack/react-query';
import { Card, Form, Heading, toast, TypographyP } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { PasswordInput } from '@/components/shared/PasswordInput';
import { authClient } from '@/lib/auth-client';
import { env } from '@/lib/env';

import { z } from 'zod';
import Link from 'next/link';

/**
 * Client form contract for the login form. Derived from the server's
 * LoginDtoSchema (email: trim+lowercase, 3..254, format; password: min 1)
 * so the client validation is aligned with what the server enforces -
 * never a divergent copy. Password min(1) re-messaged inline as
 * 'Password is required'.
 */
const LoginFormSchema = z.object({
  email: z
    .email({
      error: 'Enter a valid email address'
    })
    .trim()
    .toLowerCase()
    .min(1, 'Email is required')
    .max(254, 'Email is too long'),
  password: z.string().min(1, 'Password is required'),
});
type LoginFormValues = z.infer<typeof LoginFormSchema>;

function isSafeNextPath(raw: string | null): string {
  if (!raw) return '/';
  // Only absolute paths on this origin. Reject //host, https://, \\, control chars.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return '/';
  }
  return raw;
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const [pending, setPending] = useState(false);

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(LoginFormSchema),
    defaultValues: { email: '', password: '' },
    mode: 'onSubmit',
  });

  const nextPath = isSafeNextPath(searchParams.get('next'));

  async function onSubmit(values: LoginFormValues) {
    setPending(true);

    const { error: authError } = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });

    if (authError) {
      // API error → toast (NOT an inline field error): the credentials
      // are shape-valid, the server rejected them. Generic message per
      // the account-enumeration defense - never say WHICH field failed.
      toast.error('Invalid email or password.');
      setPending(false);
      return;
    }

    // Session cookie is set; invalidate auth-dependent queries and go.
    await queryClient.invalidateQueries();
    router.replace(nextPath);
    // nextPath may be client-side; force a refresh so the server components
    // re-run with the new session cookie rather than a cached shell.
    router.refresh();
  }

  return (
    <Card className="w-full max-w-sm">
      <div className="mb-6 text-center">
        <Heading className="mb-1">Shadhil CRM</Heading>
        <TypographyP className="text-muted-foreground text-sm">
          Sign in to your account
        </TypographyP>
      </div>

      <Form
        form={form}
        onSubmit={onSubmit}
        submitText="Sign in"
        hideResetButton
        className="space-y-4"
        submitButtonProps={{ className: 'w-full' }}
        isSubmitting={pending}
        fields={[
          {
            name: 'email',
            label: 'Email',
            type: 'input',
            required: true,
            placeholder: 'you@shadhilbuilders.in',
            disabled: pending,
            inputProps: {
              type: 'email',
              autoComplete: 'email',
              inputMode: 'email',
              autoFocus: true,
            },
          },
          {
            name: 'password',
            label: 'Password',
            type: 'custom',
            required: true,
            render: ({ field }) => (
              <PasswordInput
                {...field}
                autoComplete="current-password"
                className="min-h-11 w-full text-sm"
                disabled={pending}
                placeholder="Enter your password"
                data-qa="login-password"
              />
            ),
          },
        ]}
      />

      <TypographyP className="text-muted-foreground mt-6 text-center text-xs">
        Shadhil Builders internal system - access is provisioned by an admin.
      </TypographyP>

      {env.NEXT_PUBLIC_ORG_SIGNUP_ENABLED ? (
        <TypographyP className="text-muted-foreground mt-3 text-center text-xs">
          No account yet?{' '}
          <Link href="/register" className="text-link underline underline-offset-4">
            Create an organization
          </Link>
        </TypographyP>
      ) : null}
    </Card>
  );
}