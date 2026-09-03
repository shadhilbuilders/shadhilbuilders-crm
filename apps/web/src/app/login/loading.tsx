// T36 (PR3) — Per-route loading.tsx for /login.
//
// Next.js renders this file while the route segment's server data
// is in flight. Hard-reload /login shows this spinner immediately
// rather than a blank wall during the auth round-trip; once the
// <LoginForm> hydrates, it replaces this fallback.
//
// Per the locked decisions in the plan, the auth flow is:
//   1. User hits /login → this file renders (spinner)
//   2. Client JS hydrates → LoginForm takes over
//   3. User submits → better-auth POSTs → proxy/redirect happens
//
// Library note: the plan referenced `<Loading variant="spinner">`
// but the library v1.4.1 exports `Spinner` directly (no `Loading`
// wrapper). Using `Spinner` here keeps the dependency surface tight.
import { Spinner } from '@paalstack/react-ui';

export default function LoginLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 p-6"
      data-qa="login-loading"
    >
      <Spinner className="h-8 w-8" aria-hidden="true" />
      <p className="text-muted-foreground text-sm">Signing in…</p>
    </div>
  );
}
