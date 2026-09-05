'use client';

// Login page — better-auth email/password via the shared authClient.
//
// UX/behavior contract (frontend-developer best practices applied):
//   - Single generic error message on failure ("Invalid email or password").
//     Never reveal WHICH field was wrong (account-enumeration defense).
//   - Submit disabled while pending; button label reflects state.
//   - autocomplete="email" / "current-password" so password managers work.
//   - Redirect honors ?next=<path> (validated: only same-origin paths —
//     an attacker-supplied https://evil.example/next must not be honored).
//   - Already signed in? bounce straight to the target (client-side — the
//     middleware handles server-side; this covers after-login revisits).
//   - Password visibility toggle via the shared PasswordInput (2026-09-05).
//
// VALIDATION (2026-09-05): declarative zod via zodResolver. The schema
// is derived from the server's LoginDtoSchema (packages/api-types) —
// extending it with an explicit min-length message for the empty
// password case — so client and server rules can't drift. Field-level
// zod errors render under each input via the library Form's FieldError;
// the generic account-enumeration Alert stays for AUTH failures
// (bad credentials), which zod can't know about.
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Field,
  FieldError,
  Heading,
} from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { PasswordInput } from '@/components/shared/PasswordInput';
import { authClient } from '@/lib/auth-client';

import { z } from 'zod';

/**
 * Client form contract for the login form. Derived from the server's
 * LoginDtoSchema (email rules: trim+lowercase, 3..254, email format;
 * password: min 1) so the client validation is a superset of what the
 * server enforces — never a divergent copy. The password's min(1) is
 * re-messaged to 'Password is required' for the inline empty-case hint.
 */
const LoginFormSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Email is required')
    .max(254, 'Email is too long')
    .email('Enter a valid email address'),
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

  const [authError, setAuthError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(LoginFormSchema),
    defaultValues: { email: '', password: '' },
    mode: 'onSubmit',
  });

  const nextPath = isSafeNextPath(searchParams.get('next'));

  async function onSubmit(values: LoginFormValues) {
    setAuthError(null);
    setPending(true);

    const { error: authError } = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });

    if (authError) {
      setAuthError('Invalid email or password.');
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
        <p className="text-muted-foreground text-sm">
          Sign in to your account
        </p>
      </div>

      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <Field className="mb-4">
          <label htmlFor="login-email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
            placeholder="you@shadhilbuilders.in"
            className="border-input bg-transparent mt-1.5 min-h-11 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
            {...form.register('email')}
            disabled={pending}
            aria-invalid={form.formState.errors.email !== undefined || authError !== null}
            data-qa="login-email"
          />
          <FieldError errors={[form.formState.errors.email]} className="mt-1" />
        </Field>

        <Field className="mb-4">
          <label htmlFor="login-password" className="text-sm font-medium">
            Password
          </label>
          <div className="mt-1.5">
            <PasswordInput
              autoComplete="current-password"
              className="min-h-11 w-full text-sm"
              disabled={pending}
              placeholder="Enter your password"
              {...form.register('password')}
              aria-invalid={form.formState.errors.password !== undefined || authError !== null}
              data-qa="login-password"
            />
          </div>
          <FieldError errors={[form.formState.errors.password]} className="mt-1" />
        </Field>

        {authError !== null && (
          // NOTE: @paalstack Alert renders text via title/description props —
          // children are DISCARDED by the component (verified in dist source),
          // which is why the error initially showed as an empty box.
          // This Alert is AUTH failure ONLY (bad credentials); field-shape
          // errors are zod's inline FieldErrors above.
          <Alert colorVariant="danger" title={authError} className="mb-4" role="alert" />
        )}

        <Button type="submit" className="mt-2 h-11 w-full" disabled={pending}>
          {pending ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>

      <p className="text-muted-foreground mt-6 text-center text-xs">
        Shadhil Builders internal system — access is provisioned by an admin.
      </p>
    </Card>
  );
}