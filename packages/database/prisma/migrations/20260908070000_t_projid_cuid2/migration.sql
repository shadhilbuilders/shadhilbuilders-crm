-- T-PROJID-CUID2 (2026-09-08): re-key seed projects to real cuid2 ids.
--
-- The seed previously created projects with readable ids
-- (`seed-project-metro-heights`, `seed-project-skyline`,
-- `seed-project-lakeview`). Those ids fail z.cuid2() - the strict CUID2
-- validation the create-lead DTO and every project filter now enforce -
-- so lead creation from the /[projectId]/leads/new form returned
-- "projectId: Invalid cuid2". The route was already [projectId]; the data
-- was the problem.
--
-- Phase has a real FK (Project, onDelete: Cascade) and Lead has a real FK
-- (Project, onDelete: SetNull). To re-key the parent id we must drop those
-- FKs first (Postgres would otherwise violate them mid-update), re-key the
-- children + parent within one transaction, then restore the FKs. The FKs
-- are recreated via the constraints' original definition - same columns,
-- same onDelete semantics. Prisma schema is UNCHANGED (id is still
-- String @id) - this is a data-only migration.
--
-- Mapping (generated once with @paralleldrive/cuid2 createId(), validated
-- against z.cuid2()):
--   seed-project-metro-heights -> oe6g1xkagiisnn4oeefpdyhk
--   seed-project-skyline       -> u5ou76r0nsnximp7kwljgrgv
--   seed-project-lakeview      -> o0n22ikcbvecgkqqa6rc5aqt
--   (slug values are untouched - they were already readable)

BEGIN;

-- Drop the FKs referencing Project.id (re-added below).
ALTER TABLE "Phase" DROP CONSTRAINT IF EXISTS "Phase_projectId_fkey";
ALTER TABLE "Lead"  DROP CONSTRAINT IF EXISTS "Lead_projectId_fkey";

-- Re-key children + parent. ManagerAssignmentRule.projectId is a plain
-- column (no FK) - re-key it too for correctness.
UPDATE "Phase" SET "projectId" = 'oe6g1xkagiisnn4oeefpdyhk' WHERE "projectId" = 'seed-project-metro-heights';
UPDATE "Lead"  SET "projectId" = 'oe6g1xkagiisnn4oeefpdyhk' WHERE "projectId" = 'seed-project-metro-heights';
UPDATE "ManagerAssignmentRule" SET "projectId" = 'oe6g1xkagiisnn4oeefpdyhk' WHERE "projectId" = 'seed-project-metro-heights';
UPDATE "Project" SET "id" = 'oe6g1xkagiisnn4oeefpdyhk' WHERE "id" = 'seed-project-metro-heights';

UPDATE "Phase" SET "projectId" = 'u5ou76r0nsnximp7kwljgrgv' WHERE "projectId" = 'seed-project-skyline';
UPDATE "Lead"  SET "projectId" = 'u5ou76r0nsnximp7kwljgrgv' WHERE "projectId" = 'seed-project-skyline';
UPDATE "ManagerAssignmentRule" SET "projectId" = 'u5ou76r0nsnximp7kwljgrgv' WHERE "projectId" = 'seed-project-skyline';
UPDATE "Project" SET "id" = 'u5ou76r0nsnximp7kwljgrgv' WHERE "id" = 'seed-project-skyline';

UPDATE "Phase" SET "projectId" = 'o0n22ikcbvecgkqqa6rc5aqt' WHERE "projectId" = 'seed-project-lakeview';
UPDATE "Lead"  SET "projectId" = 'o0n22ikcbvecgkqqa6rc5aqt' WHERE "projectId" = 'seed-project-lakeview';
UPDATE "ManagerAssignmentRule" SET "projectId" = 'o0n22ikcbvecgkqqa6rc5aqt' WHERE "projectId" = 'seed-project-lakeview';
UPDATE "Project" SET "id" = 'o0n22ikcbvecgkqqa6rc5aqt' WHERE "id" = 'seed-project-lakeview';

-- Restore the FKs with their original semantics.
ALTER TABLE "Phase" ADD CONSTRAINT "Phase_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Lead" ADD CONSTRAINT "Lead_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
