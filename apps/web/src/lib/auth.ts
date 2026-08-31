// apps/web's auth surface — split by runtime so client components never pull
// the Prisma server chain into the browser bundle.
//
//   lib/auth-client.ts — browser-safe: better-auth React client ONLY.
//                        Client components import THAT, never this file.
//   auth               — better-auth SERVER instance (pulls
//                        @shadhil/database + @prisma/adapter-pg); use ONLY
//                        in server code: the app/api/auth/[...all] catch-all,
//                        route handlers, server components. Importing the
//                        server chain from a client component crashes the
//                        build with "Module not found: pg" — that's the tell.
//
// Both re-export from the shared @shadhil/auth package (single source of
// truth with the backend).
export { auth } from '@shadhil/auth';
export type { Auth, AuthSession, AuthUser } from '@shadhil/auth';