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
import { useEffect, useState } from 'react';

import {
  PortalChangePasswordForm,
  PortalChangePasswordSkeleton,
} from '@/components/portal/portal-change-password';
import { useSessionUser } from '@/lib/session';

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
