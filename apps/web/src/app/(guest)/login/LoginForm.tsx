'use client';

// Login page - "email or phone" plus password (2026-11-21).
//
// WHAT CHANGED AND WHY: better-auth's credential sign-in looks a user up by
// email alone, so a phone number cannot be given to it. The field therefore
// accepts either shape, and the password is proven by our own resolver first
// (`POST /api/public/auth/login-identifier`). When exactly one account matches,
// the resolver answers with its email and this form calls the ordinary
// `signIn.email` with it, so sessions, cookies and every better-auth hook stay
// on the path that already works. When several accounts match, the resolver
// answers with a picker; the person chooses, the same call is repeated with the
// chosen handle, and then we sign in.
//
// UX/behavior contract (kept from the previous version):
//   - ONE generic failure message for every outcome ("Invalid email, phone or
//     password."). Never reveal WHICH part was wrong, and never reveal whether
//     the account exists at all - the endpoint answers 200 for all of it.
//   - Submit disabled while pending; button label reflects state.
//   - autocomplete="username" + current-password so password managers work.
//   - Redirect honors ?next=<path> (validated: same-origin only) and uses a hard
//     navigation - see the comment in `finishSignIn` for the reproduced bug that
//     forced it.
import { Button, Card, Form, Heading, RadioGroup, toast, TypographyP } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';

import type { LoginIdentifierAccount, LoginIdentifierResult } from '@shadhil/api-types';
import { PasswordInput } from '@/components/shared/PasswordInput';
import { authClient } from '@/lib/auth-client';
import { env } from '@/lib/env';

import { z } from 'zod';
import Link from 'next/link';

/**
 * Shape check only. If it looks like an address, validate it as one; otherwise
 * require a plausible number of digits. The backend normalises with
 * `normalizePhoneDigits` and answers `invalid` for anything else, so this must
 * NOT try to be cleverer than it is.
 */
const IdentifierSchema = z
  .string()
  .trim()
  .min(1, 'Enter your email or phone number')
  .max(320, 'That is too long')
  .refine(
    (value) =>
      value.includes('@')
        ? /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
        : value.replace(/\D/g, '').length >= 6,
    { message: 'Enter your email or phone number' },
  );

const LoginFormSchema = z.object({
  identifier: IdentifierSchema,
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

/** Third line for the picker, only when two rows share an organisation. */
function roleLabel(role: string): string {
  return role
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function LoginForm() {
  const searchParams = useSearchParams();

  const [pending, setPending] = useState(false);
  const [picker, setPicker] = useState<LoginIdentifierAccount[] | null>(null);
  const [chosen, setChosen] = useState<string>('');

  // The password for the second call. A ref, not state: it must survive the
  // picker render without ever going back into the DOM or a re-render.
  const passwordRef = useRef<string>('');
  const identifierRef = useRef<string>('');

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(LoginFormSchema),
    defaultValues: { identifier: '', password: '' },
    mode: 'onSubmit',
  });

  const nextPath = isSafeNextPath(searchParams.get('next'));

  /**
   * Hard navigation, not router.replace(nextPath).
   *
   * The session cookie IS set by this point, but a client-side navigation here
   * resolved to the WRONG destination in a production build: the login page
   * prefetches the app shell, so `/` was already cached as the `proxy.ts`
   * redirect for an anonymous visitor (302 -> /login?next=/). router.replace
   * replayed that cached redirect instead of re-requesting `/` with the new
   * cookie, so the user landed back on /login with the form stuck disabled.
   * Reproduced on a production build 2026-10-01.
   *
   * `assign` over `replace` so /login stays in history: the back button then
   * returns to the sign-in form rather than closing the tab.
   */
  function finishSignIn(): void {
    window.location.assign(nextPath);
  }

  async function signInWithEmail(email: string, password: string): Promise<void> {
    const { error: authError } = await authClient.signIn.email({ email, password });
    if (authError) {
      toast.error('Invalid email, phone or password.');
      setPending(false);
      form.setValue('password', '');
      return;
    }
    finishSignIn();
  }

  async function callResolver(body: {
    identifier: string;
    password: string;
    accountUserId?: string;
  }): Promise<LoginIdentifierResult | null> {
    try {
      const response = await fetch('/api/public/auth/login-identifier', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) return null;
      return (await response.json()) as LoginIdentifierResult;
    } catch {
      return null;
    }
  }

  async function onSubmit(values: LoginFormValues) {
    setPending(true);
    identifierRef.current = values.identifier;
    passwordRef.current = values.password;

    const result = await callResolver({
      identifier: values.identifier,
      password: values.password,
    });

    if (result === null) {
      toast.error('Could not sign in right now. Please try again.');
      setPending(false);
      return;
    }
    if (result.kind === 'invalid') {
      toast.error('Invalid email, phone or password.');
      setPending(false);
      form.setValue('password', '');
      return;
    }
    if (result.kind === 'pick') {
      setPicker(result.accounts);
      setChosen('');
      setPending(false);
      // The password is spent and must not stay in a field the person can see.
      form.setValue('password', '');
      return;
    }
    await signInWithEmail(result.email, values.password);
  }

  async function onContinueWithChoice() {
    if (chosen === '') return;
    setPending(true);
    const result = await callResolver({
      identifier: identifierRef.current,
      password: passwordRef.current,
      accountUserId: chosen,
    });

    if (result === null) {
      toast.error('Could not sign in right now. Please try again.');
      setPending(false);
      return;
    }
    if (result.kind !== 'ok') {
      toast.error('Invalid email, phone or password.');
      setPicker(null);
      setPending(false);
      return;
    }
    await signInWithEmail(result.email, passwordRef.current);
  }

  function onBack() {
    setPicker(null);
    setChosen('');
    passwordRef.current = '';
    // The identifier is kept on purpose: it was not the problem, and retyping a
    // number to change your mind about the account is friction with no value.
    form.setValue('identifier', identifierRef.current);
    form.setValue('password', '');
  }

  if (picker !== null) {
    // Two rows in the same organisation cannot be told apart by the org line,
    // so BOTH rows gain the role when that happens (design decision D1).
    const duplicateOrgs = new Set(
      picker
        .map((a) => a.organizationSlug)
        .filter((slug, index, all) => all.indexOf(slug) !== index),
    );

    return (
      <Card className="w-full max-w-sm">
        <div className="mb-4">
          <Heading className="mb-1">Which account?</Heading>
          <TypographyP className="text-muted-foreground text-sm">
            This number is linked to more than one account. Choose the one to sign in to.
          </TypographyP>
        </div>

        <div className="max-h-72 overflow-y-auto" data-qa="login-account-list">
          <RadioGroup
            aria-label="Choose an account"
            value={chosen}
            onValueChange={(value) => setChosen(value ?? '')}
            options={picker.map((account) => ({
              value: account.userId,
              label: account.name,
              className: 'min-h-11',
              labelContent: (
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{account.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {account.organizationName}
                    {duplicateOrgs.has(account.organizationSlug)
                      ? ` / ${roleLabel(account.role)}`
                      : ''}
                  </span>
                </span>
              ),
            }))}
          />
        </div>

        <div className="mt-4 space-y-2">
          <Button
            className="w-full"
            onClick={onContinueWithChoice}
            disabled={chosen === ''}
            isLoading={pending}
            loadingText="Signing in..."
            data-qa="login-account-continue"
          >
            Continue
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={onBack}
            disabled={pending}
            data-qa="login-account-back"
          >
            Back
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <div className="mb-6 text-center">
        <Heading className="mb-1">Shadhil CRM</Heading>
        <TypographyP className="text-muted-foreground text-sm">Sign in to your account</TypographyP>
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
            name: 'identifier',
            label: 'Email or phone',
            type: 'input',
            required: true,
            placeholder: 'Enter your email or phone number',
            disabled: pending,
            inputProps: {
              // `username` covers both shapes for password managers. The richer
              // token has to live in inputProps - the field's own autoComplete
              // accepts only 'on' | 'off'.
              autoComplete: 'username',
              // text, not email: the email keyboard hides digits on mobile.
              inputMode: 'text',
              autoFocus: true,
              'data-qa': 'login-identifier',
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
