# Spec: Customer Progress Photos — Slice 1 (upload + staff preview)

Spec-driven development, slice 1 of the Customer Progress Portal initiative.
Source of truth for scope: `docs/designs/customer-progress-portal.md`
(APPROVED, amended with the Site-staff model; eng review CLEARED, design
review CLEARED). This spec implements the design doc's Assignment.

## Objective

Give site staff (site engineers and the site manager) a way to upload
construction progress photos per unit from their phone in under 30 seconds,
labeled by phase, and give staff/admin a preview timeline of those photos on
the unit page inside the existing CRM auth. Customers do NOT log in in this
slice; their portal and push land in slice 2 against the same data.

User stories:
1. As a site engineer, from my phone, I open a unit's Progress tab, tap the
   camera button, take a photo, pick the phase, and tap upload. Done in
   under 30 seconds; the photo appears in the timeline.
2. As the site manager, I see every engineer's uploads on the unit timeline,
   with who uploaded what and when. I can identify a bad upload (correction
   powers ship in slice 4; not here).
3. As an admin/owner, I can create an ENGINEER user and mark a team member
   as Progress lead on a project.
4. As the system, an ENGINEER user can never read a lead, chat, booking, or
   revenue surface, and can only touch photos of units on projects where
   their team is linked and they are a member.

## Tech Stack

Unchanged from the repo (AGENTS.md is authoritative):
- Next.js 16 (apps/web), NestJS 12 (apps/backend), Prisma 7
  (@shadhil/database), better-auth (@shadhil/auth-client),
  @paalstack/react-ui (UI components; Props API only), Tailwind v4.
- RLS: every business query inside `withRlsContext()`
  (packages/database/src/rls.ts); bare prisma only for migrations/seed/auth
  writes.
- Storage: existing StorageProvider (local-disk dev, imagekit prod) via
  apps/backend/src/storage — no new infrastructure.

## Commands

- Install: `pnpm install`
- Dev (all): `pnpm dev` (web 3000, api 8080, postgres 5432, redis 6379)
- Dev (backend only): `pnpm --filter backend dev`
- All tests: `pnpm test` (turbo)
- Database package tests: `pnpm --filter @shadhil/database test`
- Backend tests: `pnpm --filter backend test`
- Type-check + lint: `pnpm lint && pnpm type-check` (turbo)
- Prisma migration (local): `pnpm --filter @shadhil/database prisma migrate dev --name <name>`
- Prisma migration (prod path): see shadhil-crm-dev skill (off-VPS migration
  reference); never run migrate deploy interactively without the runbook.

## Project Structure

New in this slice:
```
packages/database/prisma/schema.prisma          → +Role ENGINEER, +ProgressPhoto, +TeamMember.photoLead
packages/database/prisma/migrations/            → migration 1: ENGINEER + photoLead + policies
                                                  (four touchpoints in ONE migration: enum,
                                                  rls.ts ROLES, better-auth field, policies)
packages/database/src/rls.ts                    → ROLES list gains 'ENGINEER'
packages/auth-client/src/auth.ts                → role additional-field (no change needed if
                                                  it passes through enum; verify at impl)
packages/database/src/progress-rls.test.ts      → DB-first RLS isolation tests
apps/backend/src/customer-progress/
  customer-progress.module.ts                   → NestJS feature module, registered in app.module.ts
  customer-progress.controller.ts               → POST /api/customer-progress/units/:unitId/photos
                                                  + GET timeline endpoints (staff roles only)
  customer-progress.service.ts                  → all writes/reads inside withRlsContext
  customer-progress.service.test.ts             → upload guards, authorization, pagination
apps/web/src/app/[orgSlug]/...unit page...      → Progress tab (upload button + phase picker +
                                                  preview timeline mirroring lead-timeline states)
apps/web/src/lib/labels.ts (or new helper)      → siteMemberLabel(member)
apps/web/src/components/teams/project-team-list.tsx → "Progress lead" toggle, ADMIN/OWNER-only
apps/web/src/app/[orgSlug]/admin/users/…        → ENGINEER option in role Select, ADMIN/OWNER-only
```

## Code Style

Follow the repo exactly; the pattern to imitate is bookings.service.ts +
media.controller.ts + lead-timeline.tsx.

```ts
// Service method shape — RLS ctx from JWT, project-team check inside tx.
async listPhotos(actor: JwtPayload, unitId: string, cursor?: string) {
  return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
    const unit = await this.assertUnitAccess(tx, actor, unitId);
    return (tx as PrismaClient).progressPhoto.findMany({
      where: { unitId: unit.id, organizationId: unit.organizationId },
      orderBy: { takenAt: 'desc' },
      take: 50,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { phase: true, createdByUser: { select: { name: true } } },
    });
  });
}
```

Conventions: colocated tests; zod DTO schemas in @shadhil/api-types;
enum labels via existing label helpers (friendly labels over raw enum);
@paalstack/react-ui Props API only; no `any`; RLS comment header on every
service ("Scoping (per JWT): every read/write flows through withRlsContext").

## Testing Strategy

- Framework: Jest, colocated `*.test.ts` next to source (repo convention).
- DB-first RLS isolation tests (REQUIRED before ship, per the 2026-09-12
  binding decision) in packages/database, following the existing pattern:
  - customer bridge is out of scope; in this slice: ENGINEER isolation
    (engineer can read/upload only own-project units' photos; engineer can
    NOT select from lead/chat/booking tables — expect the RLS deny),
    photoLead supervision boundary (non-photoLead engineer cannot UPDATE/
    DELETE another member's photo; photoLead member can), cross-project
    engineer denied.
- Service tests: upload guards (MIME allowlist, size cap MAX_UPLOAD_BYTES,
  empty file, unit-not-in-actor's-project → 403/404), pagination
  (LIMIT 50 + cursor), phase validation (phase must belong to the unit's
  project).
- Web: mirroring states tested like lead-timeline.test.tsx (skeleton, empty,
  error, hasMore).
- Manual verify: phone camera flow under 30s; upload visible in timeline
  after one refresh.

## Boundaries

- Always: run `pnpm test` + lint before commits; every business query inside
  withRlsContext(); new RLS policies ship with their DB-first tests in the
  same PR; enum value + rls.ts ROLES + better-auth field + policies land in
  ONE migration (fail-closed enum), never piecemeal.
- Ask first: touching better-auth config shape; changing media.controller
  validation limits; adding any new dependency (none expected); altering
  existing sales RLS policies.
- Never: give ENGINEER any lead/chat/booking/revenue policy row; store photo
  bytes in the database; bypass the StorageProvider; write a second role
  migration piecemeal; let ADMIN-guarded admin screens render for ENGINEER
  (nav must hide, RLS is the wall, UI is the courtesy).

## Success Criteria

1. `pnpm test` green including the new DB-first RLS isolation tests for
   ENGINEER and photoLead boundaries.
2. A seeded ENGINEER user, from a phone, completes photo upload end-to-end
   (camera → phase → upload) in under 30 seconds on the dev deployment; the
   photo renders in the unit's Progress timeline with phase chip and uploader
   name.
3. ENGINEER JWT against GET /api/leads (and chat/bookings) returns the RLS
   deny (empty/error), verified by test, not by manual curl only.
4. A non-photoLead engineer cannot mutate another member's photo (service +
   policy tests); photoLead member can.
5. Admin can assign ENGINEER role and flip Progress lead; both controls are
   hidden for non-admin sessions.
6. Timeline shows pagination after 50 photos (cursor), empty state before
   first photo, error banner on failure — mirroring the adopted state table.

## Out of scope (slice 1)

- CUSTOMER role, login, portal routes, push (slice 2 — separate spec).
- Photo correction/delete UI (slice 4) — column + policies ship now to avoid
  a destructive migration later.
- Payment/doc/message views (slice 3).
- Caption editing in v1 (captions auto-fill "{phase} {month}" server-side;
  editing is part of slice 4 supervision work).

## Open Questions

- None blocking. (Push frequency/volume question from the design doc belongs
  to slice 2's spec.)