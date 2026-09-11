-- T-ORG (2026-09-11): Gate the remaining RLS policies that were defined
-- in feature-specific migrations (outbound, inventory, feedback,
-- project-member) OUTSIDE the canonical policies.sql. Those migrations
-- predate the Organization tenant axis, so their policies were org-agnostic
-- and would leak rows across organizations. This migration DROP+CREATEs
-- them with an org gate on the table's own denormalized "organizationId"
-- column. fail-closed: current_setting returns NULL when unset, and
-- NULL = 'x' is false (never matches), so an actor without an org can see
-- nothing via these policies.

-- ── OutboundMessage ────────────────────────────────────────────────────────
-- cron full-access bypass (scans PENDING, updates status). Org-gated so the
-- system only sees the bootstrap org (withRlsContext sets it).
DROP POLICY IF EXISTS outbound_cron_service_all ON "OutboundMessage";
CREATE POLICY outbound_cron_service_all ON "OutboundMessage"
  FOR ALL
  USING (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- staff UPDATE via Lead visibility (manager/owner + admin). The policy
-- EXISTS-joins to Lead; with the denormalized column present, gate the row
-- directly AND inside the EXISTS so both the outbox row and its lead must be
-- in the actor's org.
DROP POLICY IF EXISTS outbound_update_team ON "OutboundMessage";
CREATE POLICY outbound_update_team ON "OutboundMessage"
  FOR UPDATE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "OutboundMessage"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          current_setting('app.user_role', true) = 'ADMIN'
          OR (
            current_setting('app.user_role', true) IN ('MANAGER', 'OWNER')
            AND l."teamId" = current_setting('app.user_team_id', true)
          )
        )
    )
  )
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "OutboundMessage"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          current_setting('app.user_role', true) = 'ADMIN'
          OR (
            current_setting('app.user_role', true) IN ('MANAGER', 'OWNER')
            AND l."teamId" = current_setting('app.user_team_id', true)
          )
        )
    )
  );

-- ── Unit (inventory) ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS unit_update_admin ON "Unit";
CREATE POLICY unit_update_admin ON "Unit"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── Phase (inventory) ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS phase_update_admin ON "Phase";
CREATE POLICY phase_update_admin ON "Phase"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER')
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER')
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── Feedback ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS feedback_update_admin ON "Feedback";
CREATE POLICY feedback_update_admin ON "Feedback"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- ── ProjectMember ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS project_member_write_manager_admin ON "ProjectMember";
CREATE POLICY project_member_write_manager_admin ON "ProjectMember"
  FOR ALL
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER')
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER')
    AND "organizationId" = current_setting('app.user_org_id', true)
  );
