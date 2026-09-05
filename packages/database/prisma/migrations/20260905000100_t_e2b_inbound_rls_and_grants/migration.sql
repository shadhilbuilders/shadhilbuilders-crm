-- T-E2b (2026-09-04): RLS policies + table-level GRANTs for the
-- inbound side of the WhatsApp integration.
--
-- Two tables: WebhookEvent (inbound dedup log) and
-- WhatsappUnknownContact (inbound follow-up queue).
--
-- Access patterns:
--   WebhookEvent:
--     1. CRON_SERVICE: full CRUD (the inbound webhook handler
--        runs as CRON_SERVICE; no row-level filtering needed
--        because the handler processes events serially per
--        Meta event and the dedup is via the externalId
--        unique constraint).
--     2. ADMIN: SELECT only (operators inspecting webhook
--        delivery for debugging).
--     3. shadhil_app: bare table-level GRANTs so the role can
--        read/write at all; RLS policies then gate WHICH rows.
--   WhatsappUnknownContact:
--     1. CRON_SERVICE: full CRUD (the inbound handler upserts
--        new contacts and updates message counts).
--     2. ADMIN: SELECT + UPDATE (operator/admin views and
--        status transitions; telecaller is a sub-role of ADMIN
--        for this table's purpose, since they don't own a
--        team/lead yet).
--     3. shadhil_app: bare GRANTs.

-- ────────────────────────────────────────────────────────────────────
-- WebhookEvent
-- ────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "WebhookEvent" TO shadhil_app;

ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;

-- Cron service (the inbound webhook handler) has full access.
-- The handler runs without an actor context (no app.user_id) and
-- processes Meta events serially, so no row-level filtering is
-- needed — the only invariant is that the dedup happens via the
-- externalId unique constraint.
CREATE POLICY webhook_cron_service_all ON "WebhookEvent"
  FOR ALL
  USING (current_setting('app.user_role', true) = 'CRON_SERVICE')
  WITH CHECK (current_setting('app.user_role', true) = 'CRON_SERVICE');

-- Admin: SELECT for debugging/audit; UPDATE for marking
-- processed/processedAt manually if needed.
CREATE POLICY webhook_select_admin ON "WebhookEvent"
  FOR SELECT
  USING (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY webhook_update_admin ON "WebhookEvent"
  FOR UPDATE
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

-- ────────────────────────────────────────────────────────────────────
-- WhatsappUnknownContact
-- ────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "WhatsappUnknownContact" TO shadhil_app;

ALTER TABLE "WhatsappUnknownContact" ENABLE ROW LEVEL SECURITY;

-- Cron service: full CRUD. The inbound handler upserts on
-- phoneE164 and bumps lastMessageAt/messageCount.
CREATE POLICY wa_unknown_cron_service_all ON "WhatsappUnknownContact"
  FOR ALL
  USING (current_setting('app.user_role', true) = 'CRON_SERVICE')
  WITH CHECK (current_setting('app.user_role', true) = 'CRON_SERVICE');

-- Admin: SELECT + UPDATE for the follow-up queue view. The
-- telecaller will get their own policy in Week 8+ when the UI
-- ships — for now, ADMIN-only is enough to query via psql
-- (per the T-E2b plan, the UI is a follow-up task).
CREATE POLICY wa_unknown_select_admin ON "WhatsappUnknownContact"
  FOR SELECT
  USING (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY wa_unknown_update_admin ON "WhatsappUnknownContact"
  FOR UPDATE
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

-- ────────────────────────────────────────────────────────────────────
-- Message + OutboundMessage CRON_SERVICE bypass
-- ────────────────────────────────────────────────────────────────────
-- The WhatsApp inbound webhook handler runs as CRON_SERVICE. It
-- needs to:
--   1. INSERT Message rows (channel=WHATSAPP, direction=INBOUND)
--      when a lead replies — sender is the lead, not staff.
--   2. UPDATE OutboundMessage rows when Meta sends a delivery
--      receipt (delivered/read/failed).
-- The existing message_insert_team / outbound_update_team policies
-- gate on app.user_id being a staff member with lead visibility,
-- which doesn't apply for the system. Add bypasses.
CREATE POLICY message_insert_cron_service ON "Message"
  FOR INSERT
  WITH CHECK (current_setting('app.user_role', true) = 'CRON_SERVICE');

CREATE POLICY outbound_update_cron_service ON "OutboundMessage"
  FOR UPDATE
  USING (current_setting('app.user_role', true) = 'CRON_SERVICE')
  WITH CHECK (current_setting('app.user_role', true) = 'CRON_SERVICE');

-- The inbound handler needs to SELECT the Lead (to look up by
-- phoneE164) before deciding between Message-create and
-- WhatsAppUnknownContact-upsert. Without this, the SELECT returns
-- null (no policy lets CRON_SERVICE see Lead) and every inbound
-- message is treated as an unknown number.
CREATE POLICY lead_select_cron_service ON "Lead"
  FOR SELECT
  USING (current_setting('app.user_role', true) = 'CRON_SERVICE');
