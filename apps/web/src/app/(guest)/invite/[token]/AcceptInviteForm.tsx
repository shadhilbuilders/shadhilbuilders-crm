'use client';

// AcceptInviteForm - the invitee sets up their own account.
//
// WHAT IS ABSENT, DELIBERATELY: there is no email field. The address is pinned
// on the invite, so a forwarded link cannot be claimed by a different person
// and there is nothing to mismatch. The email is shown as READ-ONLY TEXT (not a
// disabled input - a disabled field reads as "something is wrong", a labelled
// value reads as "this is what you're signing up with").
//
// PHONE is prefilled from the invite and IS editable, once. A typo'd phone has
// no verification step the way email does, so forcing a full re-invite over one
// wrong digit is a bad trade - and the server records the change in the audit
// row rather than silently accepting it.
//
// FAILURE HANDLING. A 409/410 arriving after the user has typed a password is
// the most likely failure in practice, and a toast would vanish before it was
// read, leaving the form looking merely broken. So a submission failure renders
// a PERSISTENT inline Alert above the fields, names the reason, and leaves the
// form usable.
import { Alert, Form, toast, TypographyP } from '@paalstack/react-ui';
import type { FormFieldItemType } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import {
  AcceptInviteFormSchema,
  type AcceptInviteFormValues,
  type PublicInvitePreview,
} from '@shadhil/api-types';
import { PasswordInput } from '@/components/shared/PasswordInput';
import { IntlPhoneInput } from '@/components/shared/IntlPhoneInput';
import { authClient } from '@/lib/auth-client';
import { isPlaceholderEmail } from '@shadhil/api-types';
import { DEFAULT_PHONE_COUNTRY, countryOfStored, toPhoneInputValue } from '@/lib/phone';

type Props = {
  token: string;
  preview: PublicInvitePreview;
};

type SubmitError = { title: string; body: string } | null;

export function AcceptInviteForm({ token, preview }: Props) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<SubmitError>(null);

  const form = useForm<AcceptInviteFormValues>({
    resolver: zodResolver(AcceptInviteFormSchema) as never,
    defaultValues: {
      name: preview.name,
      // Canonical digits - the field carries the country itself, so nothing is
      // shortened and no country code is lost on the first keystroke.
      phone: toPhoneInputValue(preview.phone),
      phoneCountry: countryOfStored(preview.phone) ?? DEFAULT_PHONE_COUNTRY,
      password: '',
      confirmPassword: '',
    },
    // Validate on submit, matching the admin forms.
    mode: 'onSubmit',
  });

  async function onSubmit(values: AcceptInviteFormValues) {
    setPending(true);
    setFailure(null);

    let response: Response;
    try {
      // Same-origin proxy (see app/api/public/invites/[token]/route.ts):
      // the browser cannot reach BACKEND_API_URL and has no session for the BFF.
      response = await fetch(`/api/public/invites/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          password: values.password,
          // '' means "keep the invite's number" - send nothing rather than a
          // blank string the schema would reject. A correction carries the
          // country it was typed in, so the server reads the digits correctly.
          ...(values.phone !== undefined && values.phone.trim().length > 0
            ? { phone: values.phone, phoneCountry: values.phoneCountry }
            : {}),
        }),
      });
    } catch {
      setFailure({
        title: 'Could not reach the server',
        body: 'Check your connection and try again.',
      });
      setPending(false);
      return;
    }

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      setFailure(describeFailure(response.status, body));
      setPending(false);
      return;
    }

    // Account exists. Sign in with the address the invite pinned - the tested
    // better-auth path issues the session cookie, which avoids a second auth
    // instance or a forged session here.
    const { error } = await authClient.signIn.email({
      email: preview.email,
      password: values.password,
    });

    if (error) {
      // The account IS created, so this is recoverable - say so rather than
      // implying the acceptance failed.
      setFailure({
        title: 'Account created, but sign-in failed',
        body: 'Your account exists. Go to the sign-in page and use the email and password you just set.',
      });
      setPending(false);
      return;
    }

    toast.success('Welcome aboard');
    // Full navigation (not router.push) so the session cookie is picked up by
    // the layout's server-side tenant resolution on the next request.
    window.location.assign('/');
  }

  const fields: FormFieldItemType<AcceptInviteFormValues>[] = [
    {
      type: 'input',
      name: 'name',
      label: 'Your name',
      required: true,
      inputProps: { autoComplete: 'name', 'data-qa': 'accept-name' },
    },
    {
      type: 'custom',
      name: 'phone',
      label: 'Mobile number',
      description: 'Prefilled from your invite. Change it if it is wrong.',
      render: ({ field, fieldState }) => (
        <IntlPhoneInput
          aria-invalid={fieldState.invalid}
          id={field.name}
          name={field.name}
          value={field.value ?? ''}
          onBlur={field.onBlur}
          defaultCountry={DEFAULT_PHONE_COUNTRY}
          onChange={(digits, country) => {
            field.onChange(digits);
            form.setValue('phoneCountry', country ?? DEFAULT_PHONE_COUNTRY);
          }}
          placeholder="9876543210"
          data-qa="accept-phone"
        />
      ),
    },
    {
      type: 'custom',
      name: 'password',
      label: 'Create a password',
      required: true,
      render: ({ field }) => (
        <PasswordInput
          {...field}
          autoComplete="new-password"
          placeholder="At least 8 characters"
          maxLength={128}
          className="min-h-11 w-full text-sm"
          data-qa="accept-password"
        />
      ),
    },
    {
      type: 'custom',
      name: 'confirmPassword',
      label: 'Confirm password',
      required: true,
      render: ({ field }) => (
        <PasswordInput
          {...field}
          autoComplete="new-password"
          placeholder="Repeat your password"
          maxLength={128}
          className="min-h-11 w-full text-sm"
          data-qa="accept-confirm-password"
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* role="alert" so the failure is announced, not only painted. Uses the
          Alert's own `title`/`description` props (it has no `variant`). */}
      {failure !== null ? (
        <Alert
          role="alert"
          title={failure.title}
          description={failure.body}
          data-qa="accept-error"
          className="border-destructive/40 bg-destructive/5"
        />
      ) : null}

      {/* The pinned login address: read-only PRESENTATION, with an aria-label
          rather than a disabled input. break-all because a long address must
          not push the 288px card wider on a 320px phone. */}
      <div className="border-border bg-muted/40 rounded-md border p-3">
        <p className="text-muted-foreground text-xs font-medium">You will sign in as</p>
        {isPlaceholderEmail(preview.email) ? (
          // 2026-11-21: an invite can be phone-only, and the account then holds
          // a generated `noemail+<hex>@users.invalid` address. Printing it here
          // would show the new hire a mailbox that does not exist, so the card
          // states the number instead - the one identifier they will type.
          <p
            className="text-foreground text-sm break-all"
            aria-label="Phone number this invite was sent to"
            data-qa="accept-phone-identifier"
          >
            {toPhoneInputValue(preview.phone) || 'Your phone number'}
          </p>
        ) : (
          <p
            className="text-foreground text-sm break-all"
            aria-label="Email this invite was sent to"
            data-qa="accept-email"
          >
            {preview.email}
          </p>
        )}
      </div>

      <Form
        form={form}
        id="accept-invite-form"
        onSubmit={onSubmit}
        submitText="Create my account"
        hideResetButton
        className="space-y-4"
        submitButtonProps={{
          className: 'w-full',
          isLoading: pending,
          loadingText: 'Creating account...',
          'data-qa': 'accept-invite-submit',
        }}
        fields={fields}
      />

      <TypographyP className="text-muted-foreground text-center text-xs not-first:mt-0">
        Joining {preview.organizationName}
        {preview.teamName !== null ? ` · ${preview.teamName}` : ''}
      </TypographyP>
    </div>
  );
}

/**
 * Map a non-2xx accept response to something the invitee can act on.
 *
 * The backend's codes are the contract (see INVITE_* in @shadhil/api-types);
 * anything unrecognised still gets a generic message rather than a blank alert.
 */
function describeFailure(status: number, body: unknown): { title: string; body: string } {
  const code =
    body !== null && typeof body === 'object' && 'code' in body
      ? (body as { code?: unknown }).code
      : undefined;

  if (code === 'INVITE_EXPIRED') {
    return {
      title: 'This invite has expired',
      body: 'Ask your admin to send a new one.',
    };
  }
  if (code === 'INVITE_REVOKED') {
    return {
      title: 'This invite was revoked',
      body: 'Ask your admin to send a new one.',
    };
  }
  if (code === 'INVITE_ALREADY_ACCEPTED') {
    return {
      title: 'This invite has already been used',
      body: 'Sign in instead - your account already exists.',
    };
  }
  if (code === 'INVITE_EMAIL_TAKEN' || code === 'EMAIL_ALREADY_EXISTS') {
    return {
      title: 'That email is already registered',
      body: 'Sign in instead, or ask your admin to check the invite.',
    };
  }
  if (code === 'PHONE_ALREADY_EXISTS') {
    return {
      title: 'That phone number is already in use',
      body: 'Untick the prefilled number and ask your admin to correct the invite.',
    };
  }
  if (status === 400) {
    return {
      title: 'Please check the form',
      body: 'One of the fields was not accepted. Check your password is at least 8 characters.',
    };
  }
  return {
    title: 'Something went wrong',
    body: 'Please try again, or ask your admin for a new invite.',
  };
}
