-- T-LEAD-PROJECT-REQUIRED (2026-09-16, owner ruling): a Lead MUST belong to a project.
--
-- WHAT WAS WRONG
-- `Lead.projectId` was nullable and `leads.service.create` wrote
-- `dto.projectId ?? null`, so a lead could exist belonging to no project. 140 such
-- rows accumulated in three days - every one created by a RAW INSERT in a test
-- suite, which means Prisma's `@relation` never validated them and no
-- application-layer check ever ran for those paths.
--
-- WHY IT MATTERED
-- A lead with no project is invisible on every project-scoped surface (the work
-- dashboard, the leads inbox) while still counting org-wide. So the dashboard
-- correctly showed `overdueLeads: 0` for its project while the org held 141
-- overdue leads - a correct answer that read as a broken counter.
--
-- This migration is hand-written rather than Prisma-generated. `prisma migrate
-- dev` emitted a 155-line file that DROPPED AND RECREATED every foreign key in
-- the schema (`Organization.updatedAt` was also being changed as collateral),
-- which is unreviewable and needlessly destructive for a two-line change. The
-- generated draft is replaced by exactly what must change:
--
--   1. projectId becomes NOT NULL;
--   2. its FK switches SET NULL -> RESTRICT, so deleting a Project can no longer
--      re-create project-less leads as a side effect. That is the same bug
--      arriving by another route.
--
-- ORDER MATTERS: the data must be free of NULLs before SET NOT NULL, and the FK
-- must be tightened in the same transaction. Pre-flight below fails loudly rather
-- than leaving a half-applied change.

-- Fail loudly if any project-less lead still exists. The application cannot
-- repair this (there is no way to infer the intended project), so it must be
-- resolved deliberately before the constraint is applied.
DO $$
DECLARE orphan_count int;
BEGIN
  SELECT count(*) INTO orphan_count FROM "Lead" WHERE "projectId" IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Cannot require Lead.projectId: % project-less lead(s) exist. Delete or reassign them first (SELECT id, name FROM "Lead" WHERE "projectId" IS NULL).',
      orphan_count;
  END IF;
END $$;

-- 1. Tighten the foreign key: SET NULL -> RESTRICT.
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_projectId_fkey";
ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Require a project.
ALTER TABLE "Lead" ALTER COLUMN "projectId" SET NOT NULL;
