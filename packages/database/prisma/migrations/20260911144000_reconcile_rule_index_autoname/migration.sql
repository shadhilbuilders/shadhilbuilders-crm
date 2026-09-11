/*
  Drift reconciliation (2026-09-11) - part 2: correct the ManagerAssignmentRule
  unique index name to EXACTLY match Prisma 7's auto-derived name.

  Prisma computes the constraint's index name as
  `ManagerAssignmentRule_teamId_source_priority_projectId_phas_key`
  (the explicit `@@unique name:` is NOT honored by Prisma 7's drift
  detection - verified 2026-09-11 across `--from-config-datasource` and
  `--from-migrations` diff modes, after `prisma format` + `prisma generate`).

  The prior reconciliation commit renamed the DB index to
  `..._rule_key` (a manual attempt to shorten it), which drifted from the
  schema. This migration renames the DB index to Prisma's expected
  auto-derived name so `prisma migrate diff` is empty.

  The index is a composite UNIQUE constraint; renaming preserves its
  constraint semantics.
*/
ALTER INDEX "ManagerAssignmentRule_teamId_source_priority_rule_key" RENAME TO "ManagerAssignmentRule_teamId_source_priority_projectId_phas_key";
