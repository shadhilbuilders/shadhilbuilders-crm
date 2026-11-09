-- ────────────────────────────────────────────────────────────────────────────
-- Site-update notifications (2026-11-08): make the note reach a human.
--
-- Two changes, both required for the staff notification to be visible at all:
--
-- 1. Notification.unitId. The inbox (NotificationsService.list) narrows an
--    active projectId to `leadId IN (project's lead ids)`, and the
--    notifications page always passes the active project. A site photo has no
--    lead, so without a unit anchor the notification is inserted and then
--    permanently invisible. Deliberately a bare id column (no relation), the
--    same shape as leadId - the filter narrows by id set.
--
-- 2. project_site_update_recipient_ids(), the SECURITY DEFINER recipient
--    lookup. Recipient resolution must be visibility-independent: an engineer
--    cannot read other people's ProjectStaffRole rows
--    (project_staff_role_select_own_or_admin) and Team reads are scoped to
--    their own teams, so an inline query would resolve nobody on the projects
--    they photograph. Copies unit_customer_user_ids()' shape; returns ids only.
--    The canonical copy lives in prisma/rls/policies.sql.
-- ────────────────────────────────────────────────────────────────────────────

-- ── 1. Notification.unitId ──
ALTER TABLE "Notification" ADD COLUMN "unitId" TEXT;
CREATE INDEX "Notification_unitId_idx" ON "Notification"("unitId");

-- ── 2. Site-update recipient helper ──
CREATE OR REPLACE FUNCTION project_site_update_recipient_ids(p_project_id TEXT)
  RETURNS SETOF TEXT
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT DISTINCT u."id"
    FROM "ProjectStaffRole" psr
    JOIN "User" u ON u."id" = psr."userId"
    WHERE psr."projectId" = p_project_id
      AND psr."kind" = 'PHOTO_LEAD'
      AND psr."organizationId" = current_setting('app.user_org_id', true)
      AND u."organizationId" = current_setting('app.user_org_id', true)
      AND u."deletedAt" IS NULL
    UNION
    SELECT DISTINCT u."id"
    FROM "ProjectTeam" pt
    JOIN "Team" t ON t."id" = pt."teamId"
    JOIN "User" u ON u."id" = t."managerId"
    WHERE pt."projectId" = p_project_id
      AND pt."organizationId" = current_setting('app.user_org_id', true)
      AND t."deletedAt" IS NULL
      AND u."organizationId" = current_setting('app.user_org_id', true)
      AND u."deletedAt" IS NULL
  $$;

REVOKE ALL ON FUNCTION project_site_update_recipient_ids(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION project_site_update_recipient_ids(TEXT) TO shadhil_app;
