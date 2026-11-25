-- ────────────────────────────────────────────────────────────────────────────
-- customer_self_phone() (2026-11-26): the buyer's own mobile number
-- ────────────────────────────────────────────────────────────────────────────
-- WHY A FUNCTION AND NOT A POLICY: the portal needs to show a buyer the number
-- the project office reaches them on, and that number lives on `Lead`. `Lead`
-- deliberately has no CUSTOMER SELECT policy (only telecaller, manager, admin,
-- mentioned and cron_service), because the row carries internal notes, pricing
-- and ownership the buyer must never read. A SELECT policy is row-level, so
-- granting it would hand over the whole row; RLS has no column granularity.
--
-- So the read is narrowed to ONE column, in ONE place, for ONE caller. It does
-- not restate "which lead is this buyer": customer_lead_id() already answers
-- that (role CUSTOMER, same org, not soft-deleted, pointer set), and a second
-- copy of those conditions is a second thing to keep true.
--
-- The one condition customer_lead_id() cannot carry is the LEAD's org, because
-- nothing constrains User.customerLeadId to point inside the user's own tenant.
-- That is the hole this function closes for itself, and it is the case the
-- test suite pins hardest.
CREATE OR REPLACE FUNCTION customer_self_phone() RETURNS TEXT
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT l."phone"
    FROM "Lead" l
    WHERE l."id" = customer_lead_id()
      AND l."organizationId" = current_setting('app.user_org_id', true)
  $$;

COMMENT ON FUNCTION customer_self_phone() IS
  'T-PORTAL-PHONE (2026-11-26): the caller''s own mobile number, from the lead customer_lead_id() names. One column, one caller, fail closed.';

REVOKE ALL ON FUNCTION customer_self_phone() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_self_phone() TO shadhil_app;
