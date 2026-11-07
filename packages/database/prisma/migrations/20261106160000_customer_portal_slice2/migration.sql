-- ────────────────────────────────────────────────────────────────────────────
-- Issue #8 (slice 2): Customer Progress Portal - CUSTOMER role,
-- User.customerLeadId, Organization.contactPhone, three SECURITY DEFINER
-- helpers, the creator-label customer arm, and five READ-ONLY customer
-- policies.
--
-- Spec: docs/specs/SPEC-customer-progress-slice-2.md
--
-- Decisions recorded here (they diverge from / refine the spec text):
--   * Organization.contactPhone is added (the spec's lock screen needs an
--     office number and neither Project nor Organization had one).
--   * progress_photo_creator_label() gains a customer arm; without it a
--     CUSTOMER would see "Unknown" on every photo.
--   * unit_customer_user_ids() is the PortalNotifier's recipient lookup.
--     Booking and Lead are FORCE RLS with no CRON_SERVICE arm, so a service
--     context cannot read them; the helper keeps the service identity off
--     every sales table.
--   * customer_can_read_phase()/customer_can_read_project() are two extra
--     helpers beyond the spec: its Phase/Project policy bodies subquery Unit,
--     which cycles with the slice-1 Unit engineer policy (42P17).
--   * The two push_*_portal_service policies from the spec are NOT created.
--     PortalNotifier delivers under each recipient's own context, which the
--     existing owner policies already cover (subscription read, notification
--     insert, 410 delete). Fewer policies, no new service-identity surface.
--
-- ENUM-IN-TRANSACTION (55P04): Postgres rejects USING a value added by
-- ALTER TYPE ... ADD VALUE inside the same transaction. Verified: the first
-- draft of this file failed exactly that way when the helpers compared
-- u."role" = 'CUSTOMER'. The helpers that read User.role therefore compare u."role"::text, so
-- the new enum literal is never parsed here (the escape hatch the spec
-- sanctions; same intent, no behaviour difference).
--
-- POLICIES ARE PERMISSIVE-OR. Every policy below is FOR SELECT and carries
-- the org predicate; none can change what a staff role reads. Each is gated
-- on a CUSTOMER-only predicate (customer_lead_id() is NULL for every other
-- role, and NULL = anything is not true).
--
-- NO WRITE ARM EXISTS FOR CUSTOMER ON ANY TABLE (spec D5).
--
-- RLS RECURSION: the customer predicate lives in SECURITY DEFINER helpers,
-- never inlined. A raw subquery on a FORCE-RLS table re-enters RLS (42P17 on
-- TeamMember in slice 1). Function shape copied from team_member_exists()
-- in 20261027160000_engineer_team_select.
-- ────────────────────────────────────────────────────────────────────────────

-- ── 1. Role enum ──
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'CUSTOMER' AFTER 'ENGINEER';

-- ── 2. Organization.contactPhone ──
ALTER TABLE "Organization" ADD COLUMN "contactPhone" TEXT;

-- ── 3. User.customerLeadId (nullable, indexed, SetNull, NOT unique) ──
ALTER TABLE "User" ADD COLUMN "customerLeadId" TEXT;
CREATE INDEX "User_customerLeadId_idx" ON "User"("customerLeadId");
ALTER TABLE "User"
  ADD CONSTRAINT "User_customerLeadId_fkey"
  FOREIGN KEY ("customerLeadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 4. Helpers ──

-- The caller's lead pointer, valid only when the caller is a CUSTOMER in the
-- org they claim. NULL (fail closed) without GUCs, for staff roles, and for a
-- soft-deleted user.
CREATE FUNCTION customer_lead_id() RETURNS TEXT
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT u."customerLeadId"
    FROM "User" u
    WHERE u."id" = current_setting('app.user_id', true)
      AND u."organizationId" = current_setting('app.user_org_id', true)
      AND u."role"::text = 'CUSTOMER'
      AND u."deletedAt" IS NULL
      AND u."customerLeadId" IS NOT NULL
  $$;

REVOKE ALL ON FUNCTION customer_lead_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_lead_id() TO shadhil_app;

-- True when the caller's lead has an APPROVED booking on this unit in this org.
CREATE FUNCTION customer_can_read_unit(p_unit_id TEXT) RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1
      FROM "Booking" b
      JOIN "Lead" l ON l."id" = b."leadId"
      WHERE b."unitId" = p_unit_id
        AND b."status" = 'APPROVED'
        AND b."organizationId" = current_setting('app.user_org_id', true)
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND b."leadId" = customer_lead_id()
    )
  $$;

REVOKE ALL ON FUNCTION customer_can_read_unit(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_can_read_unit(TEXT) TO shadhil_app;

-- True when the caller can read some unit in this phase / project (APPROVED
-- booking on their lead). Needed as helpers, not inline subqueries: Unit's
-- engineer policy already subqueries Phase, so a Phase policy that subqueried
-- Unit would form a policy cycle (42P17 "infinite recursion detected in
-- policy for relation Unit"). Found by the slice-1 progress-rls suite going
-- red the first time the customer policies were applied.
CREATE FUNCTION customer_can_read_phase(p_phase_id TEXT) RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1
      FROM "Unit" u
      WHERE u."phaseId" = p_phase_id
        AND u."organizationId" = current_setting('app.user_org_id', true)
        AND customer_can_read_unit(u."id")
    )
  $$;

REVOKE ALL ON FUNCTION customer_can_read_phase(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_can_read_phase(TEXT) TO shadhil_app;

CREATE FUNCTION customer_can_read_project(p_project_id TEXT) RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1
      FROM "Phase" ph
      JOIN "Unit" u ON u."phaseId" = ph."id"
      WHERE ph."projectId" = p_project_id
        AND u."organizationId" = current_setting('app.user_org_id', true)
        AND customer_can_read_unit(u."id")
    )
  $$;

REVOKE ALL ON FUNCTION customer_can_read_project(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_can_read_project(TEXT) TO shadhil_app;

-- The PortalNotifier's recipient list: the live CUSTOMER logins whose lead has
-- an APPROVED booking on this unit. Gated on the caller's org GUC (fail
-- closed without one) and on the SAME status constant as the read path, so a
-- push can never go to someone the portal would not show the photo to.
-- Callable only for the caller's own org: a service context for org A cannot
-- enumerate org B's customers.
CREATE FUNCTION unit_customer_user_ids(p_unit_id TEXT) RETURNS SETOF TEXT
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT DISTINCT u."id"
    FROM "Booking" b
    JOIN "Lead" l ON l."id" = b."leadId"
    JOIN "User" u ON u."customerLeadId" = l."id"
    WHERE b."unitId" = p_unit_id
      AND b."status" = 'APPROVED'
      AND b."organizationId" = current_setting('app.user_org_id', true)
      AND l."organizationId" = current_setting('app.user_org_id', true)
      AND u."organizationId" = current_setting('app.user_org_id', true)
      AND u."role"::text = 'CUSTOMER'
      AND u."deletedAt" IS NULL
  $$;

REVOKE ALL ON FUNCTION unit_customer_user_ids(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unit_customer_user_ids(TEXT) TO shadhil_app;

-- Creator label (replaces the slice-1 body): the ONLY change is the customer
-- arm in v_allowed. Every existing branch is byte-identical.
CREATE OR REPLACE FUNCTION progress_photo_creator_label(p_photo_id TEXT)
RETURNS TABLE (creator_name TEXT, creator_is_photo_lead BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   TEXT;
  v_role      TEXT;
  v_org_id    TEXT;
  v_creatorId TEXT;
  v_unitId    TEXT;
  v_orgId     TEXT;
  v_allowed   BOOLEAN;
BEGIN
  v_user_id := current_setting('app.user_id', true);
  v_role    := current_setting('app.user_role', true);
  v_org_id  := current_setting('app.user_org_id', true);

  -- No valid RLS context: fail closed.
  IF v_user_id IS NULL OR v_role IS NULL OR v_org_id IS NULL THEN
    RETURN;
  END IF;

  SELECT "createdBy", "unitId", "organizationId"
    INTO v_creatorId, v_unitId, v_orgId
    FROM "ProgressPhoto" WHERE "id" = p_photo_id;

  IF NOT FOUND OR v_orgId IS DISTINCT FROM v_org_id THEN
    RETURN; -- (NULL, NULL): caller reads "Unknown"
  END IF;

  -- Visibility: same access shape as the SELECT policy (ADMIN, member via
  -- ProjectTeam->TeamMember, or the linked team's manager) PLUS the slice-2
  -- customer arm: a CUSTOMER whose APPROVED booking covers the photo's unit.
  SELECT EXISTS (
    SELECT 1
      FROM "Unit" u
      JOIN "Phase" ph ON ph."id" = u."phaseId"
      JOIN "ProjectTeam" pt ON pt."projectId" = ph."projectId"
      LEFT JOIN "TeamMember" tm ON tm."teamId" = pt."teamId"
       AND tm."userId" = v_user_id
      LEFT JOIN "Team" t ON t."id" = pt."teamId"
       AND t."managerId" = v_user_id
      LEFT JOIN "ProjectStaffRole" psr
       ON psr."projectId" = ph."projectId"
      AND psr."userId" = v_user_id
      AND psr."kind" = 'PHOTO_LEAD'
      WHERE u."id" = v_unitId
        AND (tm."userId" IS NOT NULL OR t."id" IS NOT NULL)
  ) OR v_role = 'ADMIN'
    OR (v_role = 'CUSTOMER' AND customer_can_read_unit(v_unitId))
    INTO v_allowed;

  IF NOT v_allowed THEN
    RETURN; -- (NULL, NULL)
  END IF;

  IF v_creatorId IS NULL THEN
    RETURN; -- creator deleted: (NULL, NULL)
  END IF;

  RETURN QUERY
  SELECT u."name",
           EXISTS (
             SELECT 1 FROM "ProjectStaffRole" psr2
              WHERE psr2."userId" = v_creatorId
                AND psr2."projectId" = (
                  SELECT ph2."projectId"
                    FROM "Unit" u2
                    JOIN "Phase" ph2 ON ph2."id" = u2."phaseId"
                    WHERE u2."id" = v_unitId
                )
                AND psr2."kind" = 'PHOTO_LEAD'
           )
    FROM "User" u
    WHERE u."id" = v_creatorId;
END;
$$;

REVOKE ALL ON FUNCTION progress_photo_creator_label(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION progress_photo_creator_label(TEXT) TO shadhil_app;

-- ── 5. Customer policies (all FOR SELECT, all org-gated) ──
CREATE POLICY booking_select_customer ON "Booking"
  FOR SELECT USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'CUSTOMER'
    AND "status" = 'APPROVED'
    AND "leadId" = customer_lead_id()
  );

CREATE POLICY unit_select_customer ON "Unit"
  FOR SELECT USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND customer_can_read_unit("id")
  );

CREATE POLICY phase_select_customer ON "Phase"
  FOR SELECT USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND customer_can_read_phase("id")
  );

CREATE POLICY project_select_customer ON "Project"
  FOR SELECT USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND customer_can_read_project("id")
  );

CREATE POLICY progress_photo_select_customer ON "ProgressPhoto"
  FOR SELECT USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND customer_can_read_unit("unitId")
  );

-- ── 6. Grants ──
-- No new table, so no new table grants. Function grants are above, beside
-- each function. CUSTOMER has no INSERT/UPDATE/DELETE policy anywhere.
