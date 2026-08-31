# apps/web — Shadhil Builders CRM frontend

> The Next.js 16 frontend for Shadhil Builders CRM. Consumes
> [`@paalstack/react-ui`](https://github.com/paalamugan/paalstack-react-ui)
> for all UI primitives and design tokens; built on top of
> [`paalstack-nextjs-starter`](https://github.com/paalstack/paalstack-nextjs-starter).

This `apps/web/` is one half of the shadhil-crm monorepo (the other half is
`apps/backend/` — a NestJS 12 + Prisma 18 API). This README describes only
the frontend. The monorepo root README covers the system as a whole.

---

## What's here (Phase 1, August 2026)

- **Next.js 16 App Router** with Server Components and Route Handlers
- **React 19** + TypeScript strict
- **`@paalstack/react-ui`** (the umbrella package) — Buttons, Cards, Dialog,
  Sheet, Tooltip, Form, Toast, Heading, Typography*, Box, Stack, plus 60+
  others. Browse the catalog in the
  [global agent skill](file:///home/paalstack/.hermes/skills/devops/paalstack-react-ui/SKILL.md)
  or the
  [library docs](https://github.com/paalamugan/paalstack-react-ui/tree/main/docs).
- **Tailwind CSS v4** with a 3-import cascade
  (`@paalstack/react-ui/all.css` → `@shadhil/ui-tokens/brand.css` →
  `tailwindcss`). Brand colors are defined per-project in
  [`packages/ui-tokens/README.md`](../../../packages/ui-tokens/README.md).
- **TanStack Query v5** for server state — singleton client in
  `src/lib/query-client/`, mounted via `src/providers/QueryProvider`.
- **Zod v4 + `@t3-oss/env-nextjs`** for runtime env validation in
  `src/lib/env/`. Misconfigured deploys fail immediately with a clear error.
- **better-auth** catch-all at `src/app/api/auth/[...all]/route.ts`,
  sharing the same `auth` instance as the NestJS backend via the
  `@shadhil/auth` workspace package.
- **`next/font` + Inter** — the brand font is self-hosted via `next/font`,
  preloaded, no Google Fonts CDN request. See
  [`packages/ui-tokens/README.md`](../../../packages/ui-tokens/README.md#font-setup-inter-via-nextfont)
  for the setup pattern.
- **`nextjs-toploader`** for the route-progress bar.

## What is **not** here yet (planned for Phase 2+)

The starter template ships a fuller kit; we deliberately haven't pulled it
all in. Items that will arrive when a feature needs them:

- **TanStack Query hooks** (`src/hooks/queries/`, `src/hooks/mutations/`)
  — Phase 2, with the Lead Inbox.
- **`src/apis/`** — typed wrappers around backend endpoints.
- **Zustand stores** — for UI state that doesn't fit React context
  (theme, sidebar, preferences).
- **Axios apiClient + interceptors** — the current traffic is `fetch` from
  Server Components; the BFF proxy will land alongside the Lead Inbox.
- **`src/schemas/`** — Zod schemas for forms, co-located with the
  react-hook-form setup. The dev playground already exercises one
  (`src/app/dev/components/page.tsx`).
- **`withApiErrorHandling` / typed `AppError*`** — the typed error system
  exists only in `apps/backend/` for now. `apps/web/` route handlers
  throw `HttpError` from `@paalstack/react-ui/lib` directly.
- **`<Toaster />`** — imported in `src/providers/providers.tsx` but not yet
  mounted. That's a known Phase 1 TODO. Sonner toasts will appear top-right
  once it lands.
- **PostHog, Sentry, Resend** — not wired. Add via `src/providers/` when
  the analytics/monitoring/email feature lands.

The Cursor rule at `apps/web/.cursor/rules/paalstack.mdc` enforces this
"Do Not" list — don't create those folders until the first feature needs
them.

---

## Project layout (ground truth)

```
apps/web/
├── .cursor/
│   └── rules/
│       ├── paalstack.mdc       # App conventions (rewrite of starter rule)
│       ├── commit-message.mdc  # Conventional Commits
│       └── agent-skills.md     # How-to for using agent-skills with Cursor
├── .vscode/
│   └── settings.json           # Per-machine, gitignored
├── public/                     # Static assets (favicon, etc.)
├── scripts/                    # Setup helpers (env-local symlink, postinstall)
└── src/
    ├── app/                    # Next.js App Router
    │   ├── layout.tsx          # Root layout — Inter font, <Providers>, <SiteHeader>
    │   ├── page.tsx            # Phase-1 landing (force-dynamic)
    │   ├── not-found.tsx       # 404 (force-dynamic)
    │   ├── dev/
    │   │   └── components/page.tsx   # Component dev playground
    │   └── api/
    │       ├── auth/[...all]/route.ts   # better-auth catch-all
    │       ├── health/route.ts          # GET /api/health
    │       └── docs/page.tsx            # OpenAPI / Swagger UI link
    ├── components/
    │   └── SiteHeader.tsx      # Phase-1 placeholder header
    ├── lib/
    │   ├── auth.ts             # Re-exports { auth, authClient } from @shadhil/auth
    │   ├── env/
    │   │   ├── env.ts          # t3-env + zod schema (server + client)
    │   │   └── index.ts
    │   └── query-client/
    │       ├── lib.ts          # TanStack QueryClient singleton
    │       └── index.ts
    ├── providers/
    │   ├── providers.tsx       # Client provider tree (NextThemeProvider → QueryProvider)
    │   ├── query-provider.tsx
    │   ├── index.ts            # Barrel
    │   └── README.md           # When to add a provider here
    └── styles/
        └── globals.css         # 3-import cascade + @theme inline + utility overrides
```

`src/lib/` is the single home for shared infrastructure. The split between
`lib/auth.ts` (a thin re-export) and `lib/{env,query-client}/` (folders
with a barrel `index.ts`) is intentional: the auth instance is a one-line
re-export, while env and query-client own real configuration.

---

## Local dev

```bash
# From the monorepo root (apps/web is one half of the workspace)
cd /path/to/shadhil-crm

# Install everything; the apps/web postinstall hook creates
# apps/web/.env.local as a symlink → ../../.env.
pnpm install

# Start the web app (also boots postgres / pgbouncer / redis /
# NestJS backend via turbo)
pnpm dev

# Just the web app, no infra
pnpm --filter apps/web dev
```

The web app expects:
- **`apps/web/.env.local`** — symlink to `../../.env` at the monorepo
  root. Contains `BETTER_AUTH_SECRET`, `JWT_SECRET`,
  `DIRECT_DATABASE_URL`, `BACKEND_API_URL`, the `NEXT_PUBLIC_*` block,
  Sentry keys (optional), and the six regulatory inputs (RERA, CMDA, …).
- **NestJS backend running** at `BACKEND_API_URL` (default
  `http://localhost:8080`) — for `/api/auth/*` and the eventual Lead
  Inbox.

Open [http://localhost:3000](http://localhost:3000) for the landing page,
[http://localhost:3000/dev/components](http://localhost:3000/dev/components)
for the component playground (visual smoke test for `@paalstack/react-ui`
under the current CSS setup — delete this page once styling is locked in).

---

## Environment variables

All variables are validated at startup via `@t3-oss/env-nextjs` + Zod. Add
new vars to `src/lib/env/env.ts` (server-side block for `process.env`
reads; `client` block for `NEXT_PUBLIC_*`).

| Variable | Where | Required | Default | Purpose |
|---|---|---|---|---|
| `NODE_ENV` | server | no | `development` | Set automatically by Next.js (`development` / `test` / `production`) |
| `BETTER_AUTH_SECRET` | server | yes | — | Shared better-auth secret (≥32 chars) |
| `BETTER_AUTH_URL` | server | yes | — | Public URL of the web app (for auth callbacks) |
| `JWT_SECRET` | server | yes | — | Shared with NestJS JwtStrategy (≥32 chars) |
| `JWT_ISSUER` | server | no | `shadhil-crm` | JWT `iss` claim |
| `DIRECT_DATABASE_URL` | server | yes | — | Admin DB URL — bypasses PgBouncer (migrations + RLS writes) |
| `BACKEND_API_URL` | server | no | `http://localhost:8080` | NestJS BFF proxy target |
| `SENTRY_DSN` / `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | server | no | — | Sentry error monitoring (optional) |
| `NEXT_PUBLIC_API_BASE_URL` | client | no | `http://localhost:8080` | What the browser hits for the BFF |
| `NEXT_PUBLIC_APP_NAME` | client | no | `Shadhil Builders CRM` | `<title>` + brand text |
| `NEXT_PUBLIC_APP_URL` | client | no | `http://localhost:3000` | Public URL of the web app |
| `NEXT_PUBLIC_DEBUG_MODE` | client | no | `false` | Verbose client logs |
| `NEXT_PUBLIC_RERA_NUMBER`, `NEXT_PUBLIC_CMDA_NUMBER`, `NEXT_PUBLIC_RERA_VALID_FROM`, `NEXT_PUBLIC_RERA_VALID_UNTIL` | client | no | placeholders | Regulatory footer (RERA / CMDA) |
| `NEXT_PUBLIC_MODEL_C_ENABLED` | client | no | `true` | Feature flag |

`BETTER_AUTH_SECRET` and `JWT_SECRET` are shared with the NestJS backend
— they must match the values in `apps/backend/.env` or auth will fail at
boot. The shared `@shadhil/auth` workspace package depends on these being
in sync; both apps read from the same `.env` at the monorepo root.

---

## Provider tree (`src/providers/providers.tsx`)

The order matters — each layer's context is inherited by everything below it:

```
<NextThemeProvider        // next-themes wrapper, SSR-safe, drives .dark on <html>
  <QueryProvider          // @tanstack/react-query, singleton from src/lib/query-client/
    {children}            // the app routes
  >
>
```

- **`NextThemeProvider`** is from `@paalstack/react-ui`. Use it — **not**
  the homegrown `ThemeProvider` from the same package, which calls
  `localStorage.getItem` in a `useState` initializer and crashes SSR.
- **`<Toaster />`** is imported in this file but not yet mounted.
  See "What is not here yet" above.
- **Theme persistence + static prerender.** `NextThemeProvider` reads
  `localStorage` on mount for theme persistence. Next 16's static
  prerender chokes on that, so every page wrapped by `Providers` must
  opt out:

  ```tsx
  export const dynamic = 'force-dynamic';
  ```

  See `src/app/page.tsx`, `src/app/not-found.tsx`,
  `src/app/dev/components/page.tsx`, `src/app/api/docs/page.tsx` for the
  pattern.

---

## CSS cascade (`src/styles/globals.css`)

The order is intentional — last `:root` in source wins for CSS variables:

```css
@import '@paalstack/react-ui/all.css';    /* shadcn defaults + theme + utilities + toast */
@import '@shadhil/ui-tokens/brand.css';   /* shadhil-crm brand overrides */
@import 'tailwindcss';

@source '../../node_modules/@paalstack/react-ui';

@theme inline {
  --font-sans: var(--font-inter, system-ui, sans-serif); /* Inter brand font */
}

@utility container {
  @apply mx-auto px-4;
  @variant lg { @apply max-w-7xl; }
}
```

The library's `all.css` ships shadcn defaults, the `@custom-variant dark`
trigger, the 5 Base UI data-state variants, the `@theme inline` mapping
that turns `--color-X` into `bg-X` / `text-X` / `border-X` utilities, the
custom Tailwind utilities (`ps-step`, `animate-caret-blink`, `native`,
accordion keyframes), and sonner toast rules. `brand.css` overrides only
the brand slots (primary, secondary, surface).

The `@source` directive tells Tailwind to scan the library's source for
component class names, so utilities for `Card`, `Dialog`, `Tooltip`,
`Sheet`, `Form`, etc. get generated even though the library's
`styles.css` isn't imported directly.

For the brand overrides and the font setup, see
[`packages/ui-tokens/README.md`](../../../packages/ui-tokens/README.md).

---

## Dev playground (`src/app/dev/components/page.tsx`)

A real route at `/dev/components` that renders one example of every
`@paalstack/react-ui` component we use: Card, Dialog, Tooltip, Sheet,
Toast variants, Form (with `react-hook-form`). Useful for:

- Verifying the Tailwind v4 `@source` scan is picking up library classes.
- Spotting a class that needs a CSS utility we haven't added.
- Demoing the props API (every example uses the `trigger=` / `header=` /
  `footer=` / `fields=` props API rather than composition).

Not linked from anywhere in the user-facing app. **Delete this page when
component styling is verified** — the header comment in the file says the
same thing.

---

## Conventions

### Import order

ESLint sorts imports automatically:

1. Built-in Node.js modules
2. External packages
3. Internal `@/*` aliases
4. Parent / sibling / index
5. Type-only imports

### Components

- **Server Components by default.** Add `'use client'` only when you need
  state, effects, or browser-only APIs.
- **`'use client'` for providers** — `src/providers/providers.tsx` and
  `src/providers/query-provider.tsx` are the only two `.tsx` files in the
  tree that need it (they own context).

### Imports from `@paalstack/*`

- UI components from `@paalstack/react-ui` (umbrella)
- Server-safe utilities (`cn`, `logger`, `HttpError`, `httpClient`,
  `axiosDefaultConfig`) from `@paalstack/react-ui/lib`
- Hooks from `@paalstack/react-hooks` (client-only)
- Icons from a `@paalstack/react-icons/<family>` sub-path (e.g. `/lu`,
  `/hi2`) — **never** the root barrel

### No native HTML in JSX

Use `<Box as="header" />`, `<TypographyH1 />`, `<Heading as="h2" />`,
`<Button />` etc. — never raw `<div>`, `<header>`, `<h1>`, `<button>`. The
Cursor rule at `.cursor/rules/paalstack.mdc` enforces this.

### Styling

- **Semantic tokens only.** `bg-primary`, `text-muted-foreground`,
  `border-border`, `bg-accent`, `bg-card`, `bg-background`. No raw hex
  when a token exists.
- **Brand values** live in `packages/ui-tokens/src/brand.css`, not in
  `globals.css`. Edit the brand file to change colors for shadhil-crm
  (or any future project reusing the package).
- **Extend with `className`**, merge via `cn` from
  `@paalstack/react-ui/lib`.

### Env

- **Never read `process.env` directly.** Import `env` from
  `@/lib/env` and add new keys to `src/lib/env/env.ts`.
- **Server vs client keys:** `process.env.X` in the `server` block,
  `process.env.NEXT_PUBLIC_X` in the `client` block. The `client` block
  is inlined into the browser bundle — keep it small and non-sensitive.

### Commit messages

Conventional Commits via `commitlint`. The
[Cursor rule](../.cursor/rules/commit-message.mdc) reminds Cursor agents
what's allowed.

---

## Quality gates

```bash
pnpm --filter apps/web type-check   # tsc --noEmit (strict)
pnpm --filter apps/web lint         # ESLint v9 flat config
pnpm --filter apps/web test         # Vitest + React Testing Library
pnpm --filter apps/web build        # Next.js production build
```

All four run in CI on PR open and on push to `main`. PRs must pass type
check + lint + tests before merge.

---

## Deployment

Coolify auto-deploy from `main` via the Dockerfile at `apps/web/Dockerfile`
(Phase 2 — not built yet). The
[monorepo `docker/docker-compose.yml`](../../docker/docker-compose.yml)
is the local reference config; production deploy uses the same image +
env-var surface, with `BACKEND_API_URL` and the `NEXT_PUBLIC_*` block
pointed at the real hosts.

`BETTER_AUTH_SECRET` and `JWT_SECRET` must be replaced with real
`openssl rand -base64 48` values before any deploy. The repo's `.env`
ships dev placeholders; Coolify's secret store is the production source
of truth.

---

## Related

- **Library conventions** (component APIs, two-API convention, build,
  release):
  [`paalstack-react-ui` skill](file:///home/paalstack/.hermes/skills/devops/paalstack-react-ui/SKILL.md).
- **Brand tokens, font setup, OKLCH picker guide:**
  [`packages/ui-tokens/README.md`](../../../packages/ui-tokens/README.md).
- **App conventions enforced in Cursor:**
  [`apps/web/.cursor/rules/paalstack.mdc`](../.cursor/rules/paalstack.mdc).
- **Backend (NestJS 12, Prisma, RLS, better-auth shared instance):**
  `apps/backend/` (separate README when it lands).
- **Starter template this was scaffolded from:**
  [paalstack/paalstack-nextjs-starter](https://github.com/paalstack/paalstack-nextjs-starter).