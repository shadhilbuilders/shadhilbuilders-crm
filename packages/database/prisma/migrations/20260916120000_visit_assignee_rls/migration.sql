-- T-VISIT-ASSIGNEE (2026-09-16 owner ruling): the assigned sales exec can see
-- and update the visit they are sent to conduct.
--
-- Gap being closed: `site_visit_select_team` and `site_visit_write_team` scoped
-- TELECALLER and SALES_EXEC identically, via the parent Lead's ownerId /
-- coOwnerId. Under Model C the visit handoff happens while the lead is still
-- VISIT_SCHEDULED and owned by the telecaller - the exec only takes ownership
-- once the visit is recorded as VISITED. So the exec assigned to conduct a
-- visit could neither see it nor record its outcome, and the handoff (the
-- service drives VISIT_SCHEDULED -> VISITED on a COMPLETED outcome) could never
-- complete.
--
-- THE NON-OBVIOUS PART, found by running the RLS matrix instead of reasoning:
-- this policy cannot decide a non-owner exec's access by looking UP at the
-- parent Lead. `lead_select_telecaller` grants TELECALLER *and* SALES_EXEC
-- visibility only where they are that lead's ownerId/coOwnerId, and the exec is
-- not the owner while the visit is pending - so `EXISTS (SELECT 1 FROM "Lead"
-- ...)` evaluates to FALSE and hides the row. Verified empirically with a
-- focused probe: the visit was assigned to the exec, the predicate text was
-- correct, and the row was still invisible. Both branches below therefore test
-- the visit row's OWN columns.
--
-- Two earlier attempts were wrong and are recorded here so they are not
-- repeated:
--   1. Granting UPDATE without SELECT. Postgres applies the SELECT policies
--      when locating the row an UPDATE targets, so the exec's outcome write
--      failed with `P2025 "No record was found for an update"` despite the
--      UPDATE grant.
--   2. Widening `site_visit_write_team` (FOR ALL) instead of adding a separate
--      UPDATE policy. `visits.service.create()` resolves the assignee as
--      `dto.salesExecId ?? actor.sub`, so it inserts rows whose `userId` is the
--      acting telecaller - a FOR ALL grant on `userId = app.user_id` would have
--      let a SALES_EXEC CREATE visits. Scheduling is the telecaller's job, so
--      INSERT stays refused for SALES_EXEC (pinned by the RLS matrix).
--
-- Scope: TELECALLER and SALES_EXEC may act on a visit they are ASSIGNED to, in
-- addition to visits on leads they own/co-own. MANAGER's Team.managerId check
-- and ADMIN's `site_visit_write_admin` bypass are untouched. Visibility stays
-- org-scoped and requires an actual assignment, so staff still cannot see a
-- colleague's visit. DELETE is not granted.
--
-- Additive: Postgres OR's overlapping permissive policies, so no existing grant
-- is narrowed. Idempotent via DROP ... IF EXISTS.
--
-- Canonical source: packages/database/prisma/rls/policies.sql (SiteVisit
-- section) - keep the two in sync.

-- 1. SELECT: widen the staff branches to include assigned visits.
DROP POLICY IF EXISTS site_visit_select_team ON "SiteVisit";

CREATE POLICY site_visit_select_team ON "SiteVisit"
  FOR SELECT
  USING (
    "SiteVisit"."organizationId" = current_setting('app.user_org_id', true)
    AND (
      (current_setting('app.user_role', true) = 'ADMIN')
      OR (current_setting('app.user_role', true) = 'MANAGER'
          AND EXISTS (
            SELECT 1 FROM "Lead" l
            WHERE l.id = "SiteVisit"."leadId"
              AND l."organizationId" = current_setting('app.user_org_id', true)
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              )
          ))
      OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
          AND (
            "SiteVisit"."userId" = current_setting('app.user_id', true)
            OR EXISTS (
              SELECT 1 FROM "Lead" l
              WHERE l.id = "SiteVisit"."leadId"
                AND l."organizationId" = current_setting('app.user_org_id', true)
                AND (
                  l."ownerId" = current_setting('app.user_id', true)
                  OR l."coOwnerId" = current_setting('app.user_id', true)
                )
            )
          ))
    )
  );

-- 2. UPDATE: the write that drives the parent lead to VISITED. Mirrors the
--    SELECT predicate so no row is readable-but-not-writable.
DROP POLICY IF EXISTS site_visit_update_assignee ON "SiteVisit";

CREATE POLICY site_visit_update_assignee ON "SiteVisit"
  FOR UPDATE
  USING (
    "SiteVisit"."organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND (
      "SiteVisit"."userId" = current_setting('app.user_id', true)
      OR EXISTS (
        SELECT 1 FROM "Lead" l
        WHERE l.id = "SiteVisit"."leadId"
          AND l."organizationId" = current_setting('app.user_org_id', true)
          AND (
            l."ownerId" = current_setting('app.user_id', true)
            OR l."coOwnerId" = current_setting('app.user_id', true)
          )
      )
    )
  )
  WITH CHECK (
    "SiteVisit"."organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND (
      "SiteVisit"."userId" = current_setting('app.user_id', true)
      OR EXISTS (
        SELECT 1 FROM "Lead" l
        WHERE l.id = "SiteVisit"."leadId"
          AND l."organizationId" = current_setting('app.user_org_id', true)
          AND (
            l."ownerId" = current_setting('app.user_id', true)
            OR l."coOwnerId" = current_setting('app.user_id', true)
          )
      )
    )
  );
