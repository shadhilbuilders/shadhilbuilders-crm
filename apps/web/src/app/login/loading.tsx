// T36 (PR3) — Per-route loading.tsx for /login.
//
// Next.js renders this file while the route segment's server data
// is in flight. Hard-reload /login shows this skeleton immediately
// rather than a blank wall during the auth round-trip; once the
// <LoginForm> hydrates, it replaces this fallback.
//
// Skeleton, not spinner (2026-09-05): the app's loading contract is
// the shared shape-varied Skeleton (T16/T32/T34) — a spinner on an
// otherwise empty page doesn't preview the layout. This fallback
// mirrors the page's real geometry: AuthTopBar (user row) + a
// max-w-sm card-shaped block where the login form will land, so the
// page doesn't jump when the real form mounts.
//
// The auth flow is:
//   1. User hits /login → this file renders (skeleton)
//   2. Client JS hydrates → LoginForm takes over
//   3. User submits → better-auth POSTs → proxy/redirect happens
import { AuthTopBar } from '@/components/auth-top-bar';
import { Skeleton } from '@/components/shared/Skeleton';

export default function LoginLoading() {
  return (
    <div className="bg-background flex min-h-[100dvh] flex-col" data-qa="login-loading">
      <AuthTopBar />
      <main
        role="status"
        aria-busy="true"
        aria-live="polite"
        aria-label="Loading sign-in"
        className="text-ink flex flex-1 items-center justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]"
      >
        {/* Card-shaped placeholder matching LoginForm's Card (max-w-sm).
            Heading block + 2 field rows + a full-width button, mirroring
            the real form's vertical rhythm so the swap is seamless. */}
        <div className="w-full max-w-sm space-y-4 rounded-lg border p-6">
          <div className="mb-6 space-y-2 text-center">
            <Skeleton variant="text" count={1} className="mx-auto [&>div]:h-6 [&>div]:w-40" />
            <Skeleton variant="text" count={1} className="mx-auto [&>div]:h-4 [&>div]:w-56" />
          </div>
          <Skeleton variant="text" count={1} className="[&>div]:h-4 [&>div]:w-24" />
          <Skeleton variant="card" className="[&>div]:h-11 [&>div]:rounded-md" />
          <Skeleton variant="text" count={1} className="mt-2 [&>div]:h-4 [&>div]:w-24" />
          <Skeleton variant="card" className="[&>div]:h-11 [&>div]:rounded-md" />
          <Skeleton variant="card" className="mt-2 [&>div]:h-11 [&>div]:rounded-md" />
          <p className="text-muted-foreground text-center text-sm">
            Signing in…
          </p>
        </div>
      </main>
    </div>
  );
}