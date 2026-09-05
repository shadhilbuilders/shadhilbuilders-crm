-- T-E2b (2026-09-04): RLS policies + table-level GRANTs for
-- OutboundMessage.
--
-- The cron service writes OutboundMessage rows; the chat service
-- writes them under the actor's RLS context; the OutboundMessage
-- service reads/updates them. Three access patterns:
--
--   1. CRON_SERVICE (the @shadhil/auth CRON_SERVICE role that runs
--      in the backend with withRlsContext as role='CRON_SERVICE'):
--      full read + update of all rows. This is the cron processor
--      scanning PENDING rows and updating status to SENDING/SENT/
--      FAILED.
--   2. ADMIN/MANAGER/SALES_EXEC/TELECALLER (any authenticated staff):
--      insert of NEW rows (via the chat service enqueue path).
--      Read of rows for leads they can see (RLS gates via the
--      parent leadId). No delete (outbox rows are append-only
--      by design).
--   3. shadhil_app role: the bare table-level GRANTs (SELECT/
--      INSERT/UPDATE) so the role can read/write the table at all.
--      The RLS policies above then gate WHICH rows.

-- ── 1. Table-level GRANTs (T-CRONS pattern, references/postgres-multi-role-grants.md) ──
GRANT SELECT, INSERT, UPDATE ON "OutboundMessage" TO shadhil_app;

-- ── 2. RLS enable ──
ALTER TABLE "OutboundMessage" ENABLE ROW LEVEL SECURITY;

-- ── 3. Cron service: full access (the cron processor scans PENDING
--    rows and updates status; no row-level filtering for cron) ──
CREATE POLICY outbound_cron_service_all ON "OutboundMessage"
  FOR ALL
  USING (current_setting('app.user_role', true) = 'CRON_SERVICE')
  WITH CHECK (current_setting('app.user_role', true) = 'CRON_SERVICE');

-- ── 4. Staff INSERT: any authenticated role can create an outbox row
--    (the chat service does this in-RLS as the actor). The row
--    inherits the lead's visibility via the leadId. ──
CREATE POLICY outbound_insert_authenticated ON "OutboundMessage"
  FOR INSERT
  WITH CHECK (current_setting('app.user_id', true) IS NOT NULL);

-- ── 5. Staff SELECT/UPDATE/DELETE: gated by Lead visibility. We
--    join to Lead and let the Lead's existing SELECT policy decide
--    (the same pattern as Message policies in policies.sql). ──
CREATE POLICY outbound_select_team ON "OutboundMessage"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "OutboundMessage"."leadId"
        AND (
          current_setting('app.user_role', true) = 'ADMIN'
          OR (
            current_setting('app.user_role', true) IN ('MANAGER', 'OWNER')
            AND l."teamId" = current_setting('app.user_team_id', true)
          )
          OR (
            current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
            AND l."ownerId" = current_setting('app.user_id', true)
          )
        )
    )
  );

CREATE POLICY outbound_update_team ON "OutboundMessage"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "OutboundMessage"."leadId"
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
    EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "OutboundMessage"."leadId"
        AND (
          current_setting('app.user_role', true) = 'ADMIN'
          OR (
            current_setting('app.user_role', true) IN ('MANAGER', 'OWNER')
            AND l."teamId" = current_setting('app.user_team_id', true)
          )
        )
    )
  );

-- DELETE policy: append-only for staff, but admin + cron service
-- can delete for maintenance (test cleanup, manual purges). We
-- gate on the lead's teamId so a manager can only delete outbox
-- rows for their own team's leads (defense in depth, even though
-- the cron service uses shadhil_app which gets ALL via cron role).
CREATE POLICY outbound_delete_admin ON "OutboundMessage"
  FOR DELETE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    OR current_setting('app.user_role', true) = 'CRON_SERVICE'
  );

-- ── 6. The shadhil owner (used for fixtures, migrations, the seed
--    script) bypasses RLS by default. The table-level GRANTs we
--    issued above to shadhil_app don't apply to shadhil. ──
