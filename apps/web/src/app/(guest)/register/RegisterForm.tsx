'use client';

// /register - Create your organization (T-ORG-OWNER-SIGNUP, 2026-09-17).
//
// Self-service org signup: a new user supplies email/password/name plus an
// organization name. The better-auth `user.create.after` hook
// (packages/auth-client/src/org-owner.ts, wired in src/auth.ts) then:
//   1. creates a brand-new org (createdBy = this user),
//   2. promotes the user to OWNER,
//   3. binds the user's organizationId to the new org.
// The creator gets full org-wide access (OWNER downcasts to ADMIN at RLS).
//
// ENV GATE (CRITICAL): the route is only live when
// NEXT_PUBLIC_ORG_SIGNUP_ENABLED=true. It defaults OFF. When the flag is
// unset/false the form short-circuits to a "registration is closed" screen
// WITHOUT touching the auth API - so the flow can't be exercised by accident
// on a deployment that hasn't opted in.
//
// Mirrors LoginForm's UX contract: generic error message (account enum
// defense), pending submit, autocomplete hints, safe-next redirect.
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import Link from 'next/link';
import { z } from 'zod';

import { Card, Form, Heading, toast, TypographyP } from '@paalstack/react-ui';

import { PasswordInput } from '@/components/shared/PasswordInput';
import { authClient } from '@/lib/auth-client';
import { env } from '@/lib/env';

const RegisterFormSchema = z.object({
  organizationName: z
    .string()
    .trim()
    .min(2, 'Organization name must be at least 2 characters')
    .max(120, 'Organization name is too long'),
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(120, 'Name is too long'),
  email: z
    .email({ error: 'Enter a valid email address' })
    .trim()
    .toLowerCase()
    .min(1, 'Email is required')
    .max(254, 'Email is too long'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password is too long'),
});
type RegisterFormValues = z.infer<typeof RegisterFormSchema>;

function RegistrationClosed() {
  return (
    <Card className="w-full max-w-sm text-center">
      <Heading className="mb-1">Registration is closed</Heading>
      <TypographyP className="text-muted-foreground text-sm">
        New organizations aren&apos;t taking signups right now.
      </TypographyP>
      <TypographyP className="text-muted-foreground mt-4 text-sm">
        <Link href="/login" className="text-link underline underline-offset-4">
          Back to sign in
        </Link>
      </TypographyP>
    </Card>
  );
}

export function RegisterForm() {
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();

  // Env gate (client-safe NEXT_PUBLIC_). Off by default.
  const enabled = env.NEXT_PUBLIC_ORG_SIGNUP_ENABLED;

  const form = useForm<RegisterFormValues>({
    resolver: zodResolver(RegisterFormSchema),
    defaultValues: {
      organizationName: '',
      name: '',
      email: '',
      password: '',
    },
    mode: 'onSubmit',
  });

  if (!enabled) {
    return <RegistrationClosed />;
  }

  async function onSubmit(values: RegisterFormValues) {
    setPending(true);
    const { error } = await authClient.signUp.email({
      email: values.email,
      password: values.password,
      name: values.name,
      organizationName: values.organizationName,
    });

    if (error) {
      // Generic: never reveal whether the email exists or why it failed.
      toast.error(
        typeof error === 'string' ? error : error.message ?? 'Registration failed.',
      );
      setPending(false);
      return;
    }

    await queryClient.invalidateQueries();
    router.replace('/');
    router.refresh();
  }

  return (
    <Card className="w-full max-w-sm">
      <div className="mb-6 text-center">
        <Heading className="mb-1">Create your organization</Heading>
        <TypographyP className="text-muted-foreground text-sm">
          You&apos;ll become the owner of a brand-new workspace.
        </TypographyP>
      </div>

      <Form
        form={form}
        onSubmit={onSubmit}
        submitText="Create organization"
        hideResetButton
        className="space-y-4"
        submitButtonProps={{ className: 'w-full' }}
        isSubmitting={pending}
        fields={[
          {
            name: 'organizationName',
            label: 'Organization name',
            type: 'input',
            required: true,
            placeholder: 'e.g. Acme Constructions',
            disabled: pending,
            inputProps: {
              autoFocus: true,
              maxLength: 120,
            },
          },
          {
            name: 'name',
            label: 'Your name',
            type: 'input',
            required: true,
            placeholder: 'Full name',
            disabled: pending,
            inputProps: {
              autoComplete: 'name',
              maxLength: 120,
            },
          },
          {
            name: 'email',
            label: 'Email',
            type: 'input',
            required: true,
            placeholder: 'you@example.com',
            disabled: pending,
            inputProps: {
              type: 'email',
              autoComplete: 'email',
              inputMode: 'email',
            },
          },
          {
            name: 'password',
            label: 'Password',
            required: true,
            type: 'custom',
            render: ({ field }) => (
              <PasswordInput
                {...field}
                autoComplete="new-password"
                className="min-h-11 w-full text-sm"
                disabled={pending}
                placeholder="At least 8 characters"
                data-qa="register-password"
              />
            ),
          },
        ]}
      />

      <TypographyP className="text-muted-foreground mt-6 text-center text-xs">
        Already registered?{' '}
        <Link href="/login" className="text-link underline underline-offset-4">
          Sign in
        </Link>
      </TypographyP>
    </Card>
  );
}
