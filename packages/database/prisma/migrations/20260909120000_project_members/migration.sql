-- ProjectMember - explicit staff↔project assignment (autoplan 2026-09-09).
--
-- Semantics (client-confirmed "both", see schema.prisma comment):
--   1. EXPLICIT assignment is the source for linking people to projects
--      (a user can be a member of many projects; composite PK).
--   2. The effective staff list for a project = explicit ProjectMember
--      rows UNION lead-owners. Additive - never regresses who shows up.
--   3. Backfill below creates a ProjectMember for every existing lead-owner
--      so nobody disappears / isn't blockable on first deploy.
--
-- Per-project role column lets the same person hold a different role on
-- different projects. `Role` enum already exists (schema.prisma §Role).

-- ── Table ────────────────────────────────────────────────────────────────
CREATE TABLE "ProjectMember" (
    "projectId" TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "role"      TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("projectId", "userId")
);

-- ── FKs + cascade ─────────────────────────────────────────────────────────
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- index on userId so "which projects is this person on" is fast
CREATE INDEX "ProjectMember_userId_idx" ON "ProjectMember"("userId");

-- keep role values to the locked enum
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_role_check"
    CHECK ("role" IN ('OWNER', 'ADMIN', 'MANAGER', 'SALES_EXEC', 'TELECALLER'));

-- ── GRANT (shadhil_app - non-owner runtime role) ─────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "ProjectMember" TO shadhil_app;

-- ── RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE "ProjectMember" ENABLE ROW LEVEL SECURITY;

-- SELECT: every authenticated app role can read the join (staff-picker
-- use). CRON_SERVICE included for parity with Project.
CREATE POLICY project_member_select_any_authenticated ON "ProjectMember"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC', 'CRON_SERVICE')
  );

-- INSERT / UPDATE / DELETE: ADMIN class only (OWNER travels as ADMIN at the
-- RLS layer per the locked Round-21 downcast in packages/database/src/rls.ts).
CREATE POLICY project_member_write_admin ON "ProjectMember"
  FOR ALL
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

-- ── Backfill: seed every existing lead-owner as an explicit member ──────
-- DISTINCT (projectId, ownerId) from Lead; role taken from the owner's
-- User.role (falls back to their global role). Leads without a projectId
-- are excluded (no project to be a member of).
INSERT INTO "ProjectMember" ("projectId", "userId", "role")
SELECT DISTINCT l."projectId", l."ownerId", u."role"
FROM "Lead" l
JOIN "User" u ON u."id" = l."ownerId"
WHERE l."projectId" IS NOT NULL
ON CONFLICT ("projectId", "userId") DO NOTHING;
