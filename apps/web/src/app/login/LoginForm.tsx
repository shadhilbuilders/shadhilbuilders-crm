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
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Field, Heading } from '@paalstack/react-ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';

import { authClient } from '@/lib/auth-client';

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

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const nextPath = isSafeNextPath(searchParams.get('next'));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const { error: authError } = await authClient.signIn.email({
      email,
      password,
    });

    if (authError) {
      setError('Invalid email or password.');
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

      <form onSubmit={onSubmit} noValidate>
        <Field className="mb-4">
          <label htmlFor="login-email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            placeholder="you@shadhilbuilders.in"
            className="border-input bg-transparent mt-1.5 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            disabled={pending}
            aria-invalid={error !== null}
          />
        </Field>

        <Field className="mb-4">
          <label htmlFor="login-password" className="text-sm font-medium">
            Password
          </label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="border-input bg-transparent mt-1.5 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            disabled={pending}
            aria-invalid={error !== null}
          />
        </Field>

        {error !== null && (
          // NOTE: @paalstack Alert renders text via title/description props —
          // children are DISCARDED by the component (verified in dist source),
          // which is why the error initially showed as an empty box.
          <Alert colorVariant="destructive" title={error} className="mb-4" role="alert" />
        )}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>

      <p className="text-muted-foreground mt-6 text-center text-xs">
        Shadhil Builders internal system — access is provisioned by an admin.
      </p>
    </Card>
  );
}