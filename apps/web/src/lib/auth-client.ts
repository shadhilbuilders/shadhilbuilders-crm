// Browser-safe auth surface - better-auth React client ONLY.
// Client components MUST import from here, never from '@/lib/auth'
// (which re-exports the better-auth server instance and drags
// @shadhil/database -> @prisma/adapter-pg -> pg into the browser bundle:
// 'Module not found: pg' is the diagnostic).
export { authClient } from '@shadhil/auth/auth-client';
export type { AuthClient } from '@shadhil/auth/auth-client';
