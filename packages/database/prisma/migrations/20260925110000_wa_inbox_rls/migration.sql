-- T-WA-INBOX (2026-09-25): RLS for non-lead WhatsApp threads + ChatReadState.
--
-- WHY THIS MIGRATION EXISTS AS A SEPARATE FILE
-- The schema migration (20260925100000) made "Message"."leadId" nullable, which
-- silently invalidates the ONLY access-control mechanism on that table.
-- message_select_team / message_insert_team gate every row through
-- `EXISTS (SELECT 1 FROM "Lead" l WHERE l.id = "Message"."leadId" ...)`.
-- For a row with leadId = NULL that EXISTS is FALSE, so:
--   * a non-lead thread would be readable by NOBODY (feature broken), and
--   * if the predicate were ever relaxed carelessly, the Lead lookup would
--     stop being a scope check at all and the table would fall open.
-- So the NULL-lead rows need their own explicit branch. Authorization is
-- stated here ONCE and deliberately.
--
-- ROLE MODEL (DESIGN.md §4, matching the existing wa_unknown_* policies)
-- The chat system is ADMIN / OWNER / MANAGER only.
--   * ADMIN + OWNER: every thread in the org (already true for leads).
--   * MANAGER: their team's LEAD threads via Team.managerId (unchanged), and
--     ALL non-lead threads in the org - an unknown number has no Team, so
--     there is no narrower scope that could be computed. This is the same
--     grant wa_unknown_select_admin_class already gives managers over the
--     unknown-contact rows themselves, so it widens nothing.
--   * TELECALLER / SALES_EXEC: no access to non-lead threads. Their lead
--     threads keep working exactly as before (owner/co-owner branch).
-- Role rules stay OUT of the app tables and in RLS + the service layer; the
-- controller also role-guards, so a staff caller gets 403, not an empty list.

-- ── 1. ChatReadState: enable RLS + grants ───────────────────────────────────
--
-- This table MUST be RLS-protected: a row reveals which threads a user has
-- open, and it joins to Lead / WhatsappUnknownContact. A new table with RLS
-- off is world-readable to every role, which is exactly the kind of gap that
-- goes unnoticed because the feature still appears to work.

ALTER TABLE "ChatReadState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChatReadState" FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ChatReadState" TO shadhil_app;

-- A user may only ever see or write THEIR OWN read state. No ADMIN branch:
-- an admin does not need (and should not get) another user's read position,
-- and unread is per-user by design.
CREATE POLICY chat_read_state_own_lead ON "ChatReadState"
  FOR SELECT
  USING (
    "ChatReadState"."userId" = current_setting('app.user_id', true)
    AND "ChatReadState"."leadId" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "ChatReadState"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
    )
  );

CREATE POLICY chat_read_state_own_contact ON "ChatReadState"
  FOR SELECT
  USING (
    "ChatReadState"."userId" = current_setting('app.user_id', true)
    AND "ChatReadState"."contactId" IS NOT NULL
    AND current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
  );

CREATE POLICY chat_read_state_own_insert ON "ChatReadState"
  FOR INSERT
  WITH CHECK (
    "ChatReadState"."userId" = current_setting('app.user_id', true)
    AND current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
  );

CREATE POLICY chat_read_state_own_update ON "ChatReadState"
  FOR UPDATE
  USING (
    "ChatReadState"."userId" = current_setting('app.user_id', true)
    AND current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
  )
  WITH CHECK (
    "ChatReadState"."userId" = current_setting('app.user_id', true)
  );

-- ── 2. Message: SELECT branch for non-lead threads ──────────────────────────
--
-- message_select_team's EXISTS(Lead) stays untouched, so lead threads keep
-- their existing team/owner scoping. This adds the contact-thread case as a
-- SEPARATE permissive policy: Postgres ORs overlapping permissive policies,
-- so a row is visible if EITHER matches. The contact branch never consults
-- Lead, so it cannot accidentally widen access to lead threads.

CREATE POLICY message_select_contact ON "Message"
  FOR SELECT
  USING (
    "Message"."leadId" IS NULL
    AND "Message"."contactId" IS NOT NULL
    AND "Message"."organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
    AND EXISTS (
      SELECT 1 FROM "WhatsappUnknownContact" c
      WHERE c.id = "Message"."contactId"
        AND (c."organizationId" IS NULL
             OR c."organizationId" = current_setting('app.user_org_id', true))
    )
  );

-- Reply path: ADMIN/OWNER/MANAGER may write into a non-lead thread.
-- TELECALLER / SALES_EXEC are excluded (chat system is manager+ only).
CREATE POLICY message_insert_contact ON "Message"
  FOR INSERT
  WITH CHECK (
    "Message"."leadId" IS NULL
    AND "Message"."contactId" IS NOT NULL
    AND "Message"."organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER')
  );

-- ── 3. OutboundMessage: SELECT/INSERT for non-lead threads ──────────────────
--
-- Without this, replies to an unknown number would insert a Message row and
-- then FAIL on the outbox insert, or be invisible to the delivery feed. The
-- existing outbound_* policies are all lead-joined, so they need a companion
-- branch for the same reason as Message.

CREATE POLICY outbound_select_contact ON "OutboundMessage"
  FOR SELECT
  USING (
    "OutboundMessage"."leadId" IS NULL
    AND "OutboundMessage"."contactId" IS NOT NULL
    AND "OutboundMessage"."organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER', 'CRON_SERVICE')
  );

CREATE POLICY outbound_insert_contact ON "OutboundMessage"
  FOR INSERT
  WITH CHECK (
    "OutboundMessage"."leadId" IS NULL
    AND "OutboundMessage"."contactId" IS NOT NULL
    AND "OutboundMessage"."organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN ('ADMIN', 'OWNER', 'MANAGER', 'CRON_SERVICE')
  );

-- ── 4. Pre-flight: prove no pre-existing row is left unreachable ────────────
--
-- A lead-thread row must still satisfy the original lead-joined predicate.
-- (Rows with a NULL leadId cannot exist yet - the CHECK from the schema
-- migration allows them only with a contactId, and no writer creates those
-- before this ships.)

DO $$
DECLARE orphan_count int;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM "Message"
  WHERE "leadId" IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Unexpected: % Message row(s) already have a NULL leadId before the feature ships.',
      orphan_count;
  END IF;
END $$;
