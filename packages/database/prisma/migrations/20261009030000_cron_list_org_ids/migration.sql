-- T-CRON-MULTITENANT (2026-10-09): let system crons enumerate organizations.
--
-- Crons used to build their RLS context from the single PUBLIC_ORG_ID env var,
-- so with more than one Organization they only ever served one tenant (and
-- notifications for the others were stamped with the wrong organizationId).
-- A cron now iterates organizations and runs each batch in that org's own
-- CRON_SERVICE context.
--
-- Organization is FORCE-RLS and `org_cron_service_all` only admits a row whose
-- id equals app.user_org_id, so a cron cannot list orgs without already knowing
-- one. This SECURITY DEFINER function is the single, narrow way to do that: it
-- returns ids only and refuses any caller that is not the cron service account
-- (same impersonation guard as the reminder cron policy: BOTH role and user id).
CREATE OR REPLACE FUNCTION cron_list_org_ids()
RETURNS SETOF text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.user_role', true) IS DISTINCT FROM 'CRON_SERVICE'
     OR current_setting('app.user_id', true) IS DISTINCT FROM 'cron-service' THEN
    RAISE EXCEPTION 'cron_list_org_ids: caller is not the cron service account'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT "id" FROM "Organization" ORDER BY "createdAt";
END $$;

COMMENT ON FUNCTION cron_list_org_ids() IS
  'T-CRON-MULTITENANT: ids of every organization, for system crons only (role=CRON_SERVICE AND user_id=cron-service).';

REVOKE ALL ON FUNCTION cron_list_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cron_list_org_ids() TO shadhil_app;
