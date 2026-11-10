'use client';

// /portal/change-password - the buyer's forced first-login rotation
// (issue #8 slice 2, spec D3: "we always show the change-password page until
// the temporary password is replaced").
//
// WHY IT LIVES INSIDE THE PORTAL, not at the guest /change-password
// (2026-11-10). The guest page renders inside (guest)/layout.tsx: the brand
// top bar, a centered Card, and - critically - a CANCEL button wired to
// `router.push('/')`. For a gated buyer that Cancel is a trap: it leaves the
// page while the flag is still armed, every portal query answers
// 403 PASSWORD_CHANGE_REQUIRED, and the buyer ping-pongs between two screens
// with no way out. Here the portal layout owns the gate (see portalGateFor),
// the masthead keeps Sign out reachable, and there is no Cancel at all -
// the only two things a buyer can do are rotate or leave.
//
// NO NEW MACHINERY: the schema is ChangePasswordFormSchema from
// @shadhil/api-types (which EXTENDS the server's ChangePasswordDtoSchema, so
// client and server rules cannot drift), the form is the library props-API
// <Form>, and the inputs are the shared PasswordInput. Only the frame, the
// copy and the exit differ from the guest page.
//
// SUCCESS IS A DOCUMENT NAVIGATION, not router.replace. The gate reads
// mustChangePassword from the SESSION, and the client still holds the
// pre-rotation snapshot (`true`); a client-side transition would re-run the
// gate against stale data and bounce the buyer straight back to this page.
// A hard navigation re-requests /portal with the rotated session, exactly like
// the post-login and sign-out paths in this app.
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import {
  ChangePasswordFormSchema,
  type ChangePasswordFormValues,
} from '@shadhil/api-types';
import { Form, Heading, toast } from '@paalstack/react-ui';

import { PasswordInput } from '@/components/shared/PasswordInput';
import { api } from '@/apis/client';
import { useSignOut } from '@/lib/auth-actions';
import { PORTAL_HOME } from '@/lib/portal-routing';
import { useSessionUser } from '@/lib/session';

type ChangePasswordResponse = { ok: true; mustChangePassword: false };

/**
 * Layout only - full width below sm, natural width above. No height, size or
 * radius classes: the buttons keep the library's defaults (`h-8`, `rounded-lg`).
 * The library action row is `flex gap-3` with the reset button FIRST, so
 * `flex-col-reverse` puts the primary submit above Sign out on a phone while
 * `sm:flex-row` restores the usual left-to-right pair on a tablet.
 */
const ACTIONS = 'flex-col-reverse gap-3 sm:flex-row sm:justify-end [&>*]:w-full sm:[&>*]:w-auto';

export default function PortalChangePasswordPage() {
  const { user, isPending: sessionPending } = useSessionUser();

  // Hydration: better-auth's useSession resolves from the cookie on the client
  // but reports isPending during SSR, so render the skeleton for the first
  // client paint too (same pattern as the guest page and app-header).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending) {
    return <PortalChangePasswordSkeleton />;
  }

  // The layout owns the session guarantee, but the guard keeps the type narrow
  // without an assertion. A null user with no pending session means the
  // redirect in the layout is already in flight.
  if (user === null) return <PortalChangePasswordSkeleton />;

  return <PortalChangePasswordForm userId={user.id} />;
}

/** Session-pending shape: the ruled head + three 44px field rows. */
export function PortalChangePasswordSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading password form"
      data-qa="portal-change-password-skeleton"
      className="mx-auto w-full max-w-md space-y-4 py-6"
    >
      <div className="portal-rule-b space-y-3 pb-5">
        <div className="h-2.5 w-24 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
        <div className="h-9 w-2/3 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
        <div className="h-4 w-full animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <div className="h-3 w-32 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
          <div className="h-11 w-full animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

/**
 * The form itself, split from the page so it renders in a static-markup test
 * without a live session (same reason ThemeToggleButton and
 * PhotoLightboxPanel are exported). No hooks beyond the form + sign-out.
 */
export function PortalChangePasswordForm({ userId }: { userId: string }) {
  const signOut = useSignOut();
  const [pending, setPending] = useState(false);

  const form = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(ChangePasswordFormSchema),
    defaultValues: { oldPassword: '', newPassword: '', confirmPassword: '' },
    mode: 'onSubmit',
  });

  async function onSubmit(values: ChangePasswordFormValues): Promise<void> {
    setPending(true);
    try {
      // confirmPassword is client-only - the wire body is ChangePasswordDto.
      await api<ChangePasswordResponse>(`/users/${userId}/change-password`, {
        method: 'POST',
        json: { oldPassword: values.oldPassword, newPassword: values.newPassword },
      });
      toast.success('Password changed');
      window.location.assign(PORTAL_HOME);
    } catch (err: unknown) {
      // Wrong current password is a 400 with a human message ("Current password
      // is incorrect") - show it verbatim rather than inventing copy, and stay
      // on the page so the buyer can retry.
      const message = err instanceof Error ? err.message : 'Password change failed';
      toast.error(message);
      setPending(false);
    }
  }

  return (
    // pb-[max(...)] clears the iOS home indicator: this page renders with no
    // bottom bar (the layout hides PortalNav on the rotation route), so nothing
    // below absorbs that inset and the submit would sit under it.
    <div
      data-qa="portal-change-password"
      className="mx-auto w-full max-w-md pt-4 pb-[max(2.5rem,env(safe-area-inset-bottom))]"
    >
      <div className="portal-rule-b pb-5">
        <p className="portal-eyebrow">One-time step</p>
        <Heading className="portal-display mt-2 text-[1.75rem] leading-tight sm:text-[2rem]">
          Choose a new password
        </Heading>
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-[var(--portal-ink-2)]">
          Your portal was opened with a temporary password issued by the project
          office. Replace it now and you will be taken to your home.
        </p>
      </div>

      <Form
        form={form}
        onSubmit={(values) => void onSubmit(values)}
        className="mt-6"
        submitText={pending ? 'Saving...' : 'Save and continue'}
        submitButtonProps={{ type: 'submit', disabled: pending }}
        // There is deliberately no Cancel: leaving without rotating is the
        // exact state this screen exists to end. Signing out is the only exit.
        resetText="Sign out instead"
        resetButtonProps={{
          type: 'button',
          disabled: pending,
          onClick: () => void signOut(),
        }}
        actionClassName={ACTIONS}
        fields={[
          {
            type: 'custom',
            name: 'oldPassword',
            label: 'Temporary password',
            required: true,
            render: ({ field }) => (
              <PasswordInput
                {...field}
                autoComplete="current-password"
                placeholder="The password we gave you"
                maxLength={200}
                className="w-full text-sm"
                data-qa="portal-change-password-old"
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
                className="w-full text-sm"
                data-qa="portal-change-password-new"
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
                placeholder="Re-enter your new password"
                maxLength={200}
                className="w-full text-sm"
                data-qa="portal-change-password-confirm"
              />
            ),
          },
        ]}
      />

      <p className="mt-6 text-center text-xs text-[var(--portal-ink-2)]">
        Need help? Contact the project office and we will reset it for you.
      </p>
    </div>
  );
}
