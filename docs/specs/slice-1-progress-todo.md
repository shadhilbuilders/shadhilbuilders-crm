# Slice-1 implementation todo (working doc; not the spec)

STATUS 2026-11-06: T1-T8 done and merged to main (PR #8 → 198e335; CI green, Coolify deploy running). Nothing left open except the manual phone test (AC2), which has not been run.

S0. Resolved contradictions: - authority table = ProjectStaffRole (per-project, kind='PHOTO_LEAD'); photoLead text dropped - unit→project join pinned: Unit.phaseId → Phase.projectId (Unit has no projectId) - manager access: TeamMember row OR Team.managerId arm (both pinned in policies + tests) - label semantics: siteMemberLabel() - "Site Manager" if creatorIsPhotoLead, else "Site Engineer", else "Unknown" - ImageKit delete: listFiles by folder+name to resolve fileId, then deleteFile; WARN-and-resolve on failure - manual test setup: seed ids below; /inventory → unit row → Progress tab on a phone (PWA slice 2)
T1. DONE - schema.prisma: +ENGINEER enum, +ProgressPhoto (phaseId String? SetNull, createdBy String? SetNull), +ProjectStaffRole ([userId, projectId, kind] PK)
T1b. DONE - 20261026160800_customer_progress_slice1 (ONE migration, ALTER TYPE note in header). Fixed during T3: +project_team_select_engineer policy (existing any_authenticated list predated ENGINEER and starved the Phase/Unit membership subqueries).
T2. DONE - all touchpoints incl. client.ts normalizeRole THROW, users/roles.ts OWNER/ADMIN-only engineer guards, teams addMembers allowlist, nav ENGINEER→inventory-only, CreateUserForm isStaffRole/needsTeam +ENGINEER, backend teamId-required message updated
T5. DONE - customer-progress module (module/controller/service), storage.limits.ts shared, StorageProvider.delete both adapters, assertUnitAccess, cursor pagination (ORDER takenAt DESC, id DESC, LIMIT+1), label helper called per-photo
T3. DONE - packages/database/test/progress-rls.test.ts 9/9 green on a fresh db:test:reset; matrix suite 200/200 green
T6. DONE - UnitDetailSheet rebuilt as Tabs (Details/Progress; Progress-only for non-booking roles), UnitProgressTab with upload + timeline + states. Photo-lead toggle on project-team-list ENGINEER rows, checked state read from the roster payload (ProjectStaffRole rows via project-teams.service.ts) - the original payload gap is closed, no slice-2 dependency.
T6b. DONE - admin/users creatable roles +ENGINEER (OWNER + ADMIN lists only)
T7. DONE - seed: engineer@shadhilbuilders.in (SEED_ENGINEER_ID c1mg1xq8xv2xkq0n1rd5t8ea, demo-team member) + MANAGER PHOTO_LEAD grant on Metro Heights; verified on the test DB
T8. DONE - db:test:reset + database vitest 200/200, backend vitest 1417/1417 (+10 new), web vitest 1023/1023 (+2 updated), tsc clean in database/backend/web
T9. DONE - issue #7 updated with the resolved contradictions, the photo-lead payload note corrected, and the slice closed; merged to main as PR #8 (198e335).

Seed ids for manual tests: org ceid01lpfe1esm8jwsxid41k28; engineer engineer@shadhilbuilders.in / engineer_placeholder_pw (rotate before manual device test); manager manager@shadhilbuilders.in (PHOTO_LEAD on Metro Heights oe6g1xkagiisnn4oeefpdyhk); phases zpn4utpch0ncq4esh46cl4ug / s4pd095o2ll58e8ujhe7yfap / dkegmcasqq0ts5mzw6vjxpq1.
