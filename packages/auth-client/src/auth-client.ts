// better-auth client for browser/React Native.
// Mirrors the server `auth` but exposes signIn/signOut/useSession for UI.

import { createAuthClient } from 'better-auth/react';
import { adminClient } from 'better-auth/client/plugins';

// Base URL resolution for the browser auth client.
//
//   1. NEXT_PUBLIC_BETTER_AUTH_URL - explicit override (prod build arg).
//   2. window.location.origin      - the host that actually served the page.
//      Hardcoding localhost here meant any non-localhost origin (phone on a
//      LAN or Tailscale IP, a second dev host) posted sign-in to its OWN
//      localhost and failed with a connection error.
//   3. BETTER_AUTH_URL             - server-side render / Node fallback.
//   4. http://localhost:3000       - last resort, keeps plain `pnpm dev` working.
const baseURL =
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_BETTER_AUTH_URL) ||
  (typeof window !== 'undefined' && window.location?.origin) ||
  (typeof process !== 'undefined' && process.env?.BETTER_AUTH_URL) ||
  'http://localhost:3000';

// `AuthClient` from better-auth has a deeply-parameterized inferred type.
// Treat as opaque from the consumer side; runtime contract is what matters.
export const authClient: any = createAuthClient({
  baseURL,
  plugins: [adminClient()],
});

export type AuthClient = typeof authClient;
