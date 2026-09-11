-- T-INT-ADMIN (2026-09-11): widen webhook SELECT to OWNER and add an
-- OutboundMessage admin/owner SELECT policy, so the integrations ops feeds
-- (GET /api/integrations/webhook-events, /whatsapp-delivery) return rows
-- for ADMIN and OWNER. Mirrors the auditlog_select_admin_or_owner convention.

DROP POLICY IF EXISTS webhook_select_admin ON "WebhookEvent";
CREATE POLICY webhook_select_admin ON "WebhookEvent"
  FOR SELECT
  USING (
    (
      current_setting('app.user_role', true) = 'ADMIN'
      OR current_setting('app.user_role', true) = 'OWNER'
    )
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- OutboundMessage currently only has CRON_SERVICE select (outbound_cron_service_select).
-- Add an ADMIN/OWNER SELECT so the delivery feed is readable by the ops UI.
DROP POLICY IF EXISTS outbound_select_admin ON "OutboundMessage";
CREATE POLICY outbound_select_admin ON "OutboundMessage"
  FOR SELECT
  USING (
    (
      current_setting('app.user_role', true) = 'ADMIN'
      OR current_setting('app.user_role', true) = 'OWNER'
    )
    AND "organizationId" = current_setting('app.user_org_id', true)
  );
