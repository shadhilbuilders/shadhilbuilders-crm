-- T-E2b follow-up (2026-09-05): INSERT policy for WhatsappUnknownContact.
--
-- The T-E2b inbound commit (20260905000100) shipped the cron
-- INSERT-via-FOR-ALL policy but didn't ship an admin INSERT path -
-- at the time, only the webhook (CRON_SERVICE) and test fixtures
-- (the shadhil owner role) wrote to the table. Now that the
-- admin test fixtures also need to seed PENDING rows (and any
-- future operator tools might write directly), add an admin-class
-- INSERT bypass matching the SELECT/UPDATE policies from
-- migration 20260905000200.
--
-- DELETE is intentionally NOT added here - the admin class doesn't
-- delete follow-up rows (the only way a row goes away is the FK
-- cascade when the converted Lead is deleted, or the CASCADE on
-- the Lead itself; both are admin-class anyway). If operator
-- deletion is needed in the future, add a separate admin DELETE
-- policy.
CREATE POLICY wa_unknown_insert_admin_class ON "WhatsappUnknownContact"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
  );
