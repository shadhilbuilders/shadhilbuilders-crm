// better-auth client for browser/React Native.
// Mirrors the server `auth` but exposes signIn/signOut/useSession for UI.

import { createAuthClient } from 'better-auth/react';
import { adminClient } from 'better-auth/client/plugins';

const baseURL =
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_BETTER_AUTH_URL) ||
  (typeof process !== 'undefined' && process.env?.BETTER_AUTH_URL) ||
  'http://localhost:3000';

// `AuthClient` from better-auth has a deeply-parameterized inferred type.
// Treat as opaque from the consumer side; runtime contract is what matters.
export const authClient: any = createAuthClient({
  baseURL,
  plugins: [adminClient()],
});

export type AuthClient = typeof authClient;
