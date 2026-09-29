-- T-MENTION-TARGET (2026-09-29): addressed @mention recipients.
--
-- WHY THIS TABLE EXISTS
-- `emitMentions` resolved `@Name` against `User.name` with no team narrowing for
-- ordinary staff, then placed `body.slice(0, 100)` in a `chat.mention`
-- notification. So a TELECALLER could quote a lead's internal note to any
-- same-named user in the organization, and the mentioned teammate could not
-- open the lead anyway (Message RLS gates on the parent Lead's owner/co-owner).
-- A mention was therefore a name-shaped guess that leaked text and granted
-- nothing. This table records who was actually addressed.
--
-- THE RECURSION CONSTRAINT (read before editing any policy below)
-- `Lead`'s policy reads this table, so this table's policies MUST NOT read
-- `Lead` or `Message` back. If they did, Postgres would raise
-- `infinite recursion detected in policy for relation "Lead"`.
-- That is why `leadId` and `organizationId` are DENORMALIZED onto this table
-- (mirroring the parent Message): every predicate below tests this table's OWN
-- columns, so both grants terminate.

-- ── 1. Table ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "MessageRecipient" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leadId" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageRecipient_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MessageRecipient_userId_leadId_idx" ON "MessageRecipient"("userId", "leadId");
CREATE INDEX IF NOT EXISTS "MessageRecipient_leadId_idx" ON "MessageRecipient"("leadId");
CREATE INDEX IF NOT EXISTS "MessageRecipient_organizationId_idx" ON "MessageRecipient"("organizationId");
-- Idempotency: a user is addressed once per message, so mentioning the same
-- name twice cannot produce two notifications or two grants.
CREATE UNIQUE INDEX IF NOT EXISTS "MessageRecipient_messageId_userId_key" ON "MessageRecipient"("messageId", "userId");

DO $$ BEGIN
  ALTER TABLE "MessageRecipient" ADD CONSTRAINT "MessageRecipient_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MessageRecipient" ADD CONSTRAINT "MessageRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MessageRecipient" ADD CONSTRAINT "MessageRecipient_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MessageRecipient" ADD CONSTRAINT "MessageRecipient_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. RLS ───────────────────────────────────────────────────────────────────
--
-- A new table with RLS off is readable by every role, and the feature still
-- appears to work - so this section is not optional. FORCE (not just ENABLE)
-- is what constrains the table owner too.

ALTER TABLE "MessageRecipient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageRecipient" FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "MessageRecipient" TO shadhil_app;

-- Recipients read their OWN grant rows. No admin branch: an admin already sees
-- every note through message_select_team, so a wider policy here would grant
-- nothing new while making this table a second, divergent statement of who can
-- see what. Scoped by the actor's own userId so one recipient cannot enumerate
-- who else was mentioned on a thread.
DROP POLICY IF EXISTS message_recipient_select_own ON "MessageRecipient";
CREATE POLICY message_recipient_select_own ON "MessageRecipient"
  FOR SELECT
  USING (
    "MessageRecipient"."organizationId" = current_setting('app.user_org_id', true)
    AND "MessageRecipient"."userId" = current_setting('app.user_id', true)
  );

-- The SENDER writes the recipient rows, in the same transaction as the message.
-- `userId <> app.user_id` stops a self-mention creating a grant row (the service
-- also skips notifying yourself); self-mention is meaningless here because the
-- sender can already see the lead by construction.
--
-- This deliberately does NOT check that the author can see the lead: the
-- enclosing withRlsContext transaction already had to pass message_insert_team
-- to create the Message this row hangs off, and the denormalized leadId is
-- copied from that committed row. Re-checking would require reading `Lead`
-- (see the recursion note above) and could not be evaluated as an INSERT
-- WITH CHECK anyway.
DROP POLICY IF EXISTS message_recipient_insert_author ON "MessageRecipient";
CREATE POLICY message_recipient_insert_author ON "MessageRecipient"
  FOR INSERT
  WITH CHECK (
    "MessageRecipient"."organizationId" = current_setting('app.user_org_id', true)
    AND "MessageRecipient"."userId" <> current_setting('app.user_id', true)
    AND current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC')
  );

-- No UPDATE policy: a grant is immutable once written. Editing who was
-- mentioned would silently change who can read a past note, so revocation is
-- deliberately not expressible. (The FK's ON DELETE CASCADE is the only
-- removal path, and it fires with the parent message.)

-- ── 3. Lead: a mention is a real grant of the lead ───────────────────────────
--
-- OWNER INSTRUCTION (2026-09-29): choosing option A - "mention grants the lead
-- record AND its full thread, including the customer WhatsApp conversation,
-- bounded to the actor's team scope".
--
-- Separate permissive policy (Postgres ORs them), so lead_select_telecaller and
-- the manager/admin branches are untouched. Self-contained predicate: it reads
-- MessageRecipient's own columns only, never Lead - which is what keeps this
-- terminating. A NULL recipient leadId matches nothing, so contact-thread
-- recipients (leadId IS NULL) gain no lead access, and neither do their
-- Message rows (message_select_recipient requires a non-NULL leadId).

DROP POLICY IF EXISTS lead_select_mentioned ON "Lead";
CREATE POLICY lead_select_mentioned ON "Lead"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
    AND "Lead"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "MessageRecipient" mr
      WHERE mr."leadId" = "Lead"."id"
        AND mr."userId" = current_setting('app.user_id', true)
        AND mr."organizationId" = current_setting('app.user_org_id', true)
    )
  );

-- ── 4. Message: a mention grants the whole thread (option A) ─────────────────
--
-- KEYED ON THE LEAD, NOT THE MESSAGE. The first draft matched
-- `mr."messageId" = "Message"."id"`, which granted only the mentioned note: the
-- live probe showed the exec could read the internal note but NOT the customer's
-- message on the same lead (0 rows), i.e. the notification sent them to a thread
-- they still could not read. Option A is "the lead record AND its full thread",
-- so the grant is per-lead.
--
-- Consequence, stated deliberately: once mentioned on a lead, the recipient can
-- read ALL messages on that lead - past, present and future, any kind. That is
-- what a grant means; it is not scoped to the note that created it. Revoking it
-- means deleting the MessageRecipient row (no UPDATE policy is defined).
--
-- Reads MessageRecipient's own columns; never joins back through Lead (the
-- recursion constraint at the top of this file).

DROP POLICY IF EXISTS message_select_recipient ON "Message";
CREATE POLICY message_select_recipient ON "Message"
  FOR SELECT
  USING (
    "Message"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "MessageRecipient" mr
      WHERE mr."leadId" = "Message"."leadId"
        AND mr."userId" = current_setting('app.user_id', true)
        AND mr."organizationId" = current_setting('app.user_org_id', true)
        AND mr."leadId" IS NOT NULL
    )
  );

-- ── 5. Pre-flight: prove the new policies cannot open a hole ────────────────
--
-- The grant table starts empty, so no pre-existing row can change hands. Assert
-- it, so a re-run against a partially-populated environment fails loudly rather
-- than silently widening access to notes written before this feature.

DO $$
DECLARE grant_count int;
BEGIN
  SELECT count(*) INTO grant_count FROM "MessageRecipient";
  IF grant_count > 0 THEN
    RAISE EXCEPTION
      'Unexpected: % MessageRecipient row(s) exist before this feature ships - existing note visibility would change.',
      grant_count;
  END IF;
END $$;
