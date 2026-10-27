---
spec_issue_number: 7
spec_issue_url: https://github.com/shadhilbuilders/shadhilbuilders-crm/issues/7
spec_filed_at: 2026-10-26T15:58:54Z
spec_branch: main
spec_plan_mode: inactive
spec_executed: false
spec_worktree_path:
---

# feat(customer-progress): slice 1 - photo upload + staff preview timeline
## Context

Buyers of Shadhil Builders have no way to see construction progress; they email the site manager and wait. This is slice 1 of the approved Customer Progress Portal design (docs/designs/customer-progress-portal.md; eng + design reviews CLEARED 2026-10-26): give site staff a phone-first photo upload per unit, labeled by phase, with a staff-facing preview timeline. Slice 2 (separate spec) adds customer logins, portal routes and push against this same data.

## Current State

Verified 2026-10-26 (main @ f3c5490):
- No ProgressPhoto model, no customer-progress module (grep clean across apps/backend/src, packages/database).
- One sibling commit cbca47a proves the photo blob path works in this stack (offline consumer wiring test).
- Storage: apps/backend/src/storage has StorageProvider interface (storage.provider.ts:35-53), local-disk + imagekit adapters, media.controller.ts:59 @Post upload with MIME allowlist + MAX_UPLOAD_BYTES.
- Role enum has 5 values (schema.prisma); rls.ts:104-112 holds a hardcoded ROLES list that throws on unknown roles (fail-closed). Adding ENGINEER touches 4 places that must ship together, never piecemeal.
- TeamMember/ProjectTeam are the authoritative joins (2026-09-12 binding decision); a person's role sits on User, but project access sits on team membership.
- Phase model exists (schema.prisma:556-570), per-project, staff-managed.

## Proposed Change

Slice 1 = upload + staff preview, no customer surface.

Architecture (data flow):
```
[site staff phone: unit Progress (inside UnitDetailSheet or its own subroute; see UI note)]
  | POST /api/customer-progress/units/:unitId/photos (any staff JWT; authorization = role x project-access matrix below)
  v
[customer-progress.controller] -> withRlsContext(...)
  | 1. unit in actor's org + project-team membership check (RLS + service assert)
  | 2. validation mirrors media.controller.ts: base64 JSON, MIME allowlist, MAX_UPLOAD_BYTES
  | 3. storage.save(...) via StorageProvider -> {key, mimeType, filename, size}
  | 4. tx.progressPhoto.create({unitId, phaseId, key, caption(auto "{phase} {month}"), takenAt, createdBy})
  v
[unit page Progress tab timeline] (staff preview, mirrors lead-timeline.tsx states)
```

### Implementation Details

Schema (one migration):
```prisma
enum Role { ... existing 5 ... ENGINEER }

model ProgressPhoto {
  id             String   @id @default(cuid())
  unitId         String
  phaseId        String?
  organizationId String
  key            String   // storage key from StorageProvider.save
  mimeType       String
  filename       String
  caption        String   // auto-filled "{phase.name} {month name} {year}" en-GB, month from takenAt converted to UTC at the server (e.g. "Foundation October 2026"); editable slice 4
  takenAt        DateTime
  createdBy      String?
  createdAt      DateTime @default(now())
  unit      Unit         @relation(fields: [unitId], references: [id], onDelete: Cascade)
  phase     Phase?       @relation(fields: [phaseId], references: [id], onDelete: SetNull)
  createdByUser User?   @relation("ProgressPhotoCreator", fields: [createdBy], references: [id], onDelete: SetNull)
  @@index([unitId, takenAt(sort: Desc)])
  @@index([organizationId])
}
```
Plus a NEW per-project authority table (replaces the per-team photoLead idea; per-team leaks to sibling projects when one team links to multiple projects):
```prisma
model ProjectStaffRole {
  userId         String
  projectId      String
  organizationId String
  kind           String   // only 'PHOTO_LEAD' in slice 1; open for future kinds
  assignedById   String?
  assignedAt     DateTime @default(now())
  user       User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  project    Project    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  assignedBy User?      @relation("ProjectStaffRoleAssignedBy", fields: [assignedById], references: [id], onDelete: SetNull)
  @@id([userId, projectId, kind])
  @@index([projectId])
}
```
RLS: SELECT own rows + rows in own org for ADMIN/OWNER; INSERT/DELETE for ADMIN/OWNER org-wide (per-project authority, exactly what the flag needed; no sibling-project leak; multi-team users unambiguous). Reverse relations to add in the same migration: Unit.progressPhotos ProgressPhoto[], Phase.progressPhotos ProgressPhoto[], User.createdProgressPhotos ProgressPhoto[] @relation("ProgressPhotoCreator") Phase/Unit/User FK onDelete: Unit=Cascade (unit gone -> photos gone), Phase=SetNull (photos survive; caption retains the last label text; createdBy is String? + creator relation SetNull so label falls back "Unknown").

SIX-touchpoint ENGINEER migration (ONE migration, ONE release; adding any one alone fail-closes all RLS contexts or breaks JWT verification). The closed role set is referenced in MORE places than the design doc's "four": at minimum:
1. Prisma enum Role += ENGINEER (packages/database/prisma/schema.prisma)
2. packages/database/src/rls.ts ROLES list += 'ENGINEER' (throws on unknown at runtime)
3. packages/auth-client/src/jwt.ts:25 ROLES const (JWT verification rejects unlisted roles) + roles.ts exhaustive check honored
4. packages/api-types/src/enums.ts RoleSchema/Role enum += 'ENGINEER' + friendly label map (labels.ts) += "Site Engineer (user)"-style entry consistent with existing labels
5. Navigation/role-gating maps: grep apps/web for role lists (admin layout CAN_MANAGE maps, sidebar nav config); add ENGINEER so nav renders ONLY the permitted surfaces for it
6. RLS policies:
   a. Dependency reads for ENGINEER (so the feature is usable at all): policies EXPLICITLY SCOPED, never org-wide: SELECT on Project for projects where EXISTS(ProjectTeam pt JOIN TeamMember tm ON tm.teamId=pt.teamId AND tm.userId=current_setting('app.user_id'), same organizationId) - membership alone, role-agnostic (the actor's role is already ENGINEER by the outer policy predicate); identical pattern on Unit (unit.projectId), Phase (phase.projectId), ProjectTeam (rows of the engineer's teams), TeamMember (own rows only). Existing policies on those tables enumerate roles today; EXTEND them with the join-shaped ENGINEER clause, NOT a bare role name (a bare ENGINEER addition would expose all org units). Pattern for the join: progressphoto policy below. GRANTs to shadhil_app for every touched table in the same migration.
   b. ProgressPhoto: SELECT/INSERT for ENGINEER with WITH CHECK/USING: EXISTS(ProjectTeam pt WHERE pt.projectId = unit's project AND EXISTS(TeamMember tm WHERE tm.teamId = pt.teamId AND tm.userId = app.user_id AND tm.organizationId = app.user_org_id)) — the join is EXPLICIT in the policy text (ProjectTeam -> TeamMember on teamId+userId); org-wide engineer visibility is forbidden.
   c. ProgressPhoto UPDATE/DELETE (final rule): creator may update/delete their OWN photo (createdBy = app.user_id, any role); other-member photos require a ProjectStaffRole(userId=actor, projectId=photo's project, kind='PHOTO_LEAD') row. ADMIN (which includesOWNER via downcast): UPDATE/DELETE + SELECT + INSERT org-wide, no membership needed. Non-member staff of any role: service 403 + RLS empty.
Impl step: grep the current 5 role strings at start; every hit site is a touchpoint. Verified in code: apps/web/src/apis/client.ts has ROLES/STAFF_ROLES + normalizeRole() that DEFAULTS unknown roles to TELECALLER (change to THROW); apps/backend/src/users/roles.ts has exhaustive Record<Role,...> maps incl. assertCanCreateRole/assertCanChangeRole (ENGINEER creatable/assignable by OWNER/ADMIN ONLY, never MANAGER regardless of canManageUsers); apps/web/src/lib/session.ts exhaustive maps (+ENGINEER, rank below SALES_EXEC, weight inert); AddTeamMembersDialog role filter (+ENGINEER). Exhaustiveness checks make every missed mirror a build failure.

Module: apps/backend/src/customer-progress/{module,controller,service}.ts registered in app.module.ts. Every business query inside withRlsContext(); comment header "Scoping (per JWT): every read/write flows through withRlsContext".

Endpoints:
- POST /api/customer-progress/units/:unitId/photos (upload)
- GET /api/customer-progress/units/:unitId/photos (staff timeline; cursor pagination, LIMIT 50, takenAt desc, include phase + createdByUser name)
- POST /api/customer-progress/projects/:projectId/members/:userId/photo-lead (body { photoLead: boolean }: true upserts ProjectStaffRole(userId, projectId, kind='PHOTO_LEAD'); false deletes that row; response DTO { userId, projectId, photoLead: boolean } (NOT a TeamMember row); AUTHORIZATION: service guard role in (OWNER, ADMIN) exactly; MANAGER excluded; toggle renders only for OWNER/ADMIN sessions; ADMIN/OWNER-ONLY per withRlsContext note below)
- ENGINEER TeamMember eligibility: do NOT touch lead-assignment lists (isLinkableStaffRole at apps/web/src/lib/session.ts:86 and CANDIDATE_ROLES at apps/backend/src/teams/team-members.service.ts:66 stay WITHOUT ENGINEER so lead co-owner/replacement never see engineers). ENGINEER is added ONLY to team-membership add paths (the teams module addMembers role allowlist and AddTeamMembersDialog filter gain a separate TEAM_ONLY_STAFF_ROLES list = current staff roles + ENGINEER). auto-assign pool untouched (only TELECALLER routed). assertCanCreateRole/assertCanChangeRole (users/roles.ts): ENGINEER assignable by OWNER/ADMIN only. Seed: +one demo engineer + one demo photo-lead manager (with a ProjectStaffRole row) per demo project. Member add reuses the existing team addMembers endpoint.
Authorization matrix (single source of truth; service asserts, RLS enforces):
| Role            | Upload | Read timeline | Set/clear photoLead | Notes |
|-----------------|--------|---------------|---------------------|-------|
| ENGINEER        | yes, own-project units only | yes, own-project only | no | zero other surfaces |
| MANAGER         | yes, if ProjectTeam member of that project | yes, same rule | no | |
| SALES_EXEC/TELECALLER | yes, if ProjectTeam member | yes, same rule | no | sales staff on project teams keep upload (they already see units via existing access) |
| ADMIN/OWNER     | yes, org-wide (role travel) | yes, org-wide | yes | no membership row needed |
Non-member staff (MANAGER/SALES_EXEC/TELECALLER/ENGINEER, no ProjectTeam row for the unit's project): 403 by service AND empty by RLS; only ADMIN/OWNER are membership-exempt.
- Upload DTO (zod, in @shadhil/api-types): { phaseId: string(cuid), base64: string, mimeType: string, filename: string(<=180), takenAt: ISO datetime string, clientDeviceHint: optional enum(camera|gallery) }. takenAt is client-captured local time converted to UTC (phone clock acceptable; caption uses server month).
- MIME allowlist for THIS route: image/jpeg, image/png, image/webp. HEIC is REJECTED at validation with message "please use JPEG"; iOS Safari camera <input accept="image/*"> with a converter is a slice-2 concern (rendering stack decision); slice 1 keeps the storage+render path single-MIME. guessMime serving .heic as octet-stream is untouched (boundary).
- Size cap: 10MB. media.controller.ts MAX_UPLOAD_BYTES is a module-local const today (line 39): this slice EXPORTS it from a new shared const module apps/backend/src/storage/storage.limits.ts and imports it in BOTH media.controller and customer-progress (one definition, two consumers; behavior unchanged for chat).
- Timeline response DTO (single authoritative shape): { photos: [{ id, unitId, phaseId: string|null, phaseName: string|null, mimeType, filename, caption, takenAt, createdAt, creatorName: string|null, creatorIsPhotoLead: boolean|null, mediaUrl }], nextCursor: string|null }. creator fields are precomputed by the service through a SECURITY DEFINER SQL helper progress_photo_creator_label(p_photo_id) -> TABLE(creator_name text, creator_is_photo_lead boolean), with `SET search_path = public`, REVOKE ALL FROM PUBLIC + GRANT EXECUTE to shadhil_app only, and an INTERNAL tenant+visibility predicate: the function first verifies the caller context (app.user_id/app.user_role/app.user_org_id) may read the photo (same predicate as the ProgressPhoto SELECT policy, ADMIN or member join), returning (NULL, NULL) rows for photos the caller cannot read - no cross-org leak. Caller must hold a valid RLS context (the service calls it inside withRlsContext). Null/unknown: missing user -> (NULL, NULL); caller reads label "Unknown". mediaUrl = "/api/bff/media/<urlencoded key>" EMITTED BY THE NEST ROUTE as a relative path (browser resolves against origin; BFF proxies to /api/media). Upload response: the same photo object shape.
- "Green chip where current": chip is green when phaseName equals the phase of the unit's MOST RECENT photo in the response set (client-side computation, no schema change); otherwise neutral. No "current phase" field exists in this slice.
- Cursor pagination: stable composite ordering ORDER BY takenAt DESC, id DESC (id tiebreaks timestamp collisions); query parameter `?cursor=` holds opaque base64 JSON {takenAt: ISO string with offset, id}; a missing/invalid cursor = fresh first page (malformed cursor is NOT an error: it behaves as absent, logged at debug); next-page predicate: (takenAt, id) lexicographically less than the cursor pair; the query fetches LIMIT+1 rows and emits nextCursor (base64 of the 50th row's pair, rounded DOWN to the 50 returned) only when row 51 existed. takenAt accepts any ISO 8601 with offset; server normalizes to UTC; upload without an offset is rejected (400).
- photoLead endpoint: body { photoLead: boolean }; response TeamMember row; 403 for non-admin; write route inside the existing ADMIN-only project-team RLS path.

Phase source: UploadDto requires phaseId validated to belong to the unit's project. No new taxonomy.

Web UI: units live at inventory; unit detail is UnitDetailSheet (apps/web/src/components/inventory/UnitDetailSheet.tsx) opened from the inventory table. Progress ships as a tab INSIDE UnitDetailSheet (no new route needed; the sheet already has unit context and is reachable by the exact staff who hold unit access), with sheet-level role gating hiding the tab from roles without project access.
- camera-first CTA ("Add first photo" empty state; "Add photo" otherwise), `<input type="file" accept="image/*" capture>`
- phase Select over the unit's project phases (zod-validated DTO)
- preview timeline: newest first, phase chip (green = the phase of the unit's most recent photo in the loaded set; neutral otherwise), uploader label via siteMemberLabel(creatorName, creatorIsPhotoLead) rendering ONLY the server-precomputed DTO fields (contract in the endpoints section; no client-side team lookups), date
- states mirror adopted state table: skeleton cards (lead-timeline shape), warm empty, inline error banner + retry, hasMore load-more
- hidden from roles without project access: the Progress tab visibility data source is the SAME membership query the timeline uses (GET returns 403 without membership; the sheet renders the tab only on 2xx). Nav for ENGINEER: only inventory (unit list) + the Progress tab inside the sheet; every other nav item (leads, work, admin, settings) is filtered out for role ENGINEER by the existing nav config (grep role-gated nav maps at impl; the nav route list for ENGINEER is: inventory only).

Admin mechanics:
- Admin > Users role Select (ADMIN/OWNER-only per canManageUsers tightening for ENGINEER assignment): + ENGINEER option
- project-team-list.tsx expandable member rows: "Progress lead" toggle, ADMIN/OWNER-only, ADMIN-only RLS write path (inherits existing wall)
- siteMemberLabel(creatorName, creatorIsPhotoLead) in web lib = pure renderer of the DTO's precomputed fields (label = creatorIsPhotoLead true ? "Site Manager" : creatorName null ? "Unknown" : "Site Engineer"); no client-side team resolution: TeamMember RLS hides other members' rows by design; label authority is the server helper above.

## Acceptance Criteria

1. `pnpm test` green including new DB-first RLS isolation tests: ENGINEER isolation (can only photos of own-project units; denied on leads/chat/bookings), cross-project engineer denied, non-photoLead cannot UPDATE/DELETE another member's photo, photoLead member can.
2. Manual upload protocol (CI-independent): seeded ENGINEER user, any Android phone with Chrome >= 120 on the dev LAN; stopwatch from first tap on "Add photo" until the photo is VISIBLE in the timeline (upload complete + list refreshed); 3 runs, median reported in the PR body; pass = median <= 30s; photo renders with phase chip + uploader label.
3. Direct RLS reads under an ENGINEER context: SELECT from Lead/Message/Booking returns EMPTY SET (exact assertion: array length 0, no error). Service-level authorization on customer-progress routes for non-members returns HTTP 403. Both exact assertions in tests; "empty vs error" is pinned, not "empty/error".
4. Upload guards: wrong MIME, oversize, empty file, unit outside actor's project -> 4xx with clear messages; service-tested.
5. Timeline paginates at 50 (cursor), shows empty state pre-photo, error banner on failure: matches adopted state table.
6. Admin controls (ENGINEER option, Progress lead toggle) hidden in sessions without admin rights.
7. No degradation of existing functionality: full existing suite passes.

Each test states its card: protects=<observable>; fails_when=<wrong result it rejects>; no_claim=<what green does not prove>.

## Testing Plan

| Layer       | What                                                     | Count |
|-------------|----------------------------------------------------------|-------|
| Unit        | upload guards, pagination, phase validation, siteMemberLabel | +8   |
| Integration | DB-first RLS isolation (engineer, photoLead, cross-project) | +4   |
| E2E (manual, slice gate) | phone camera flow under 30s; timeline renders            | +1   |

## Rules for the implementing agent

1. Acceptance criteria are the protects/fails_when/no_claim profile of each test; never make tests pass artificially.
2. Real code and real tests land in the same change; no placeholder.
3. Any change to validators, CI steps, or suppression pragmas is reported on its own line with justification.
4. A reported command names the command and its observed result; stderr never silenced.
5. Your report is a claim until the parent re-executes it.

## Storage atomicity

storage.save() runs BEFORE the transaction (bytes must exist to be referenced). Failure path: DB write fails after save -> service deletes the stored object by key. Compensation contract: StorageProvider gains `delete(key: string): Promise<void>` (interface addition in this slice, implemented in BOTH adapters: local-disk = fs.rm; imagekit = its delete API, or log-only WARN fallback when the client lacks one — blob then orphaned until provider lifecycle). Retry creates a NEW key (unique suffix per provider contract): no collision with orphaned blobs. Unit-tested on both adapters (including the imagekit fallback WARN path and API-error path: a delete API error logs WARN and resolves; the upload request has ALREADY failed at that point, so no user-facing success is possible).

## Rollback Plan

Single PR revert removes endpoints, tab, and admin controls. The migration is forward-only: revert of code without migration rollback leaves ENGINEER + ProgressPhoto + photoLead in the DB, inert (no code references remain). Do NOT roll back the RLS grant policies in a hotfix (fail-closed: absent rows deny, safe).

## Effort Estimate

- Schema + migration + RLS policies: ~3h
- customer-progress module (controller/service): ~5h
- DB-first RLS isolation tests: ~4h
- Web Progress tab + upload flow + states: ~6h
- Admin mechanics (role option, toggle, label helper): ~2.5h
Total: ~20h human-equivalent (CC-assisted: ~2h)

## Files Reference

| File | Change |
|------|--------|
| packages/database/prisma/schema.prisma | +ENGINEER enum, +ProgressPhoto, +TeamMember.photoLead |
| packages/database/prisma/migrations/<new> | one migration: enum + column + policies |
| packages/database/src/rls.ts:104-112 | ROLES += ENGINEER |
| packages/auth-client/src/auth.ts | verify role passthrough; touch only if needed |
| packages/database/test/progress-rls.test.ts (new; database vitest includes test/** only per vitest.config.ts:7) | DB-first isolation tests |
| apps/backend/src/customer-progress/* (new) | module, controller, service + tests |
| apps/backend/src/app.module.ts | register module |
| apps/web/src/components/inventory/UnitDetailSheet.tsx | + Progress tab (upload flow, timeline, states) |
| apps/web/src/components/teams/project-team-list.tsx | Progress lead toggle |
| apps/web/src/app/[orgSlug]/admin/users/ | ENGINEER role option guard |
| apps/web/src/lib/labels.ts | siteMemberLabel() |

## Out of Scope

- CUSTOMER role, portal routes, customer login, push (slice 2, separate spec)
- Photo correction/delete UI (slice 4; policy rows ship now per approved decision)
- Payment/document/message views (slice 3)
- Caption editing (slice 4)
- Bets on push frequency/volume (slice 2 concern)

## RLS pinning (exact behavior)

- Policies on ProgressPhoto: member SELECT + INSERT (WITH CHECK) via explicit ProjectTeam->TeamMember join OR Team.managerId ownership (a MANAGER who leads a linked team has access WITHOUT a duplicate TeamMember row: policy predicate includes EXISTS(Team t WHERE t.id = pt.teamId AND t.managerId = app.user_id) as an alternative arm), + organizationId match; ADMIN policies cover OWNER via the locked withRlsContext downcast (rls.ts sets app.user_role = 'ADMIN' for OWNER: there are NO separate OWNER policies; the matrix's ADMIN/OWNER = role ADMIN at the GUC), org-wide by role+org only; UPDATE/DELETE: role ADMIN org-wide, creator own-photo, otherwise ProjectStaffRole PHOTO_LEAD row for the photo's project. GRANT on the table to shadhil_app via the existing grant block pattern in the same migration. Non-ENGINEER roles' existing policies on OTHER tables are untouched (boundary).
- ENGINEER on sales tables: NO row added (deny by default; policies are permissive-by-absence under RLS). Verified behavior: SELECT under RLS with no matching policy returns EMPTY SET (not an error) — the portal/timeline must therefore rely on the service-level 403 for authorization messaging, never on RLS emptiness, which is indistinguishable from "no photos yet".
- Required DB tests must run inside the repo's existing RLS test harness (SET LOCAL via withRlsContext); a pass = rows returned/denied exactly as the matrix says.
- Non-ENGINEER roles' existing policies elsewhere are untouched (boundary: never edit sales policies in this PR).

## Related

- docs/designs/customer-progress-portal.md (approved design; site-staff model amendment)
- Eng review: ~/.gstack/.../paalstack-main-eng-review-<TS>.md (CLEARED)
- Design review: same doc (CLEARED, 9 decisions)
