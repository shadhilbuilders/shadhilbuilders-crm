// Re-export from shared @shadhil/auth so apps/web uses the exact same auth
// instance as the backend (single source of truth).
export { auth, authClient } from '@shadhil/auth';
export type { Auth, AuthSession, AuthUser } from '@shadhil/auth';
