/*
  Drift reconciliation (2026-09-11): bring the live DB schema in line with
  schema.prisma for two pre-existing mismatches that surfaced when the
  feedback migration ran `prisma migrate dev` (it tried to DROP/readd a
  column and rename a truncated index on every diff).

  1. ProjectMember.role was created as TEXT (with a CHECK) in migration
     20260909120000_project_members, but schema.prisma declares it as the
     `Role` enum. Prisma wants a destructive DROP + ADD. Because the table
     is empty (0 rows), we instead do a safe in-place type cast (ALTER TYPE
     with USING) and drop the now-redundant CHECK. The CHECK must be
     dropped BEFORE the cast: Postgres re-validates the CHECK when altering
     the column type, and the text-array CHECK has no `Role = text` operator
     (verified: the first attempt failed with E42883). This order preserves
     the column's position and any future data.

  2. The ManagerAssignmentRule unique index name was being generated past
     Postgres's 63-char identifier limit and getting truncated (the DB has
     `ManagerAssignmentRule_teamId_source_priority_projectId_phaseId_`).
     The schema now declares a SHORT explicit @@unique name
     ("teamId_source_priority_rule", authored 2026-09-11), so Prisma's
     stable name is `ManagerAssignmentRule_teamId_source_priority_rule_key`
     (51 chars, inside the limit). We rename the index to match.
*/
-- 1. ProjectMember.role: TEXT + CHECK -> Role enum (in-place cast, table is empty)
ALTER TABLE "ProjectMember" DROP CONSTRAINT "ProjectMember_role_check";
ALTER TABLE "ProjectMember" ALTER COLUMN "role" TYPE "Role" USING "role"::"Role";

-- 2. ManagerAssignmentRule: rename truncated unique index to the stable form
ALTER INDEX "ManagerAssignmentRule_teamId_source_priority_projectId_phaseId_" RENAME TO "ManagerAssignmentRule_teamId_source_priority_rule_key";
