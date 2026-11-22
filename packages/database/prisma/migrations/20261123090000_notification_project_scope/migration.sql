-- Notification.projectId - denormalized from whatever the row anchors to.
--
-- WHY. The staff inbox always filters to the active project, and it had to
-- resolve that by asking for every lead id in the project and every unit id in
-- the project, then matching `leadId IN (...) OR unitId IN (...)`. Two extra
-- reads on the bell, and a project with thousands of leads makes that list
-- large for no reason. With the column, the filter is one equality.
--
-- Nullable on purpose: rows written before this migration are backfilled below,
-- org-level events (`feedback.created`) belong to no project, and a future
-- anchor that is not a lead or a unit would also be legitimately null.

ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

-- Backfill from the anchor. Lead first: it is the majority of rows and the only
-- anchor every project-scoped type uses. A row whose lead was deleted keeps
-- NULL, which matches the old behaviour of being hidden under a project filter.
UPDATE "Notification" n
SET "projectId" = l."projectId"
FROM "Lead" l
WHERE n."projectId" IS NULL
  AND n."leadId" IS NOT NULL
  AND n."leadId" = l."id";

-- Unit-anchored rows (site updates) take their unit's project, which lives on
-- the PHASE: Unit -> Phase -> Project. Unit has no projectId of its own.
UPDATE "Notification" n
SET "projectId" = ph."projectId"
FROM "Unit" u
JOIN "Phase" ph ON ph."id" = u."phaseId"
WHERE n."projectId" IS NULL
  AND n."unitId" IS NOT NULL
  AND n."unitId" = u."id";

CREATE INDEX IF NOT EXISTS "Notification_userId_projectId_createdAt_idx"
  ON "Notification" ("userId", "projectId", "createdAt");
