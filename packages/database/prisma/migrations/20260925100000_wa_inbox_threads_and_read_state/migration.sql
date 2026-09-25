-- T-WA-INBOX (2026-09-25): WhatsApp chat system for managers/admin/owner.
--
-- WHAT THIS DOES
-- Lets a WhatsApp conversation exist for a number that is NOT a lead yet.
--
--  1. "Message".leadId becomes NULLABLE and gains "contactId", so a message
--     belongs to exactly one thread: a Lead (known customer) or a
--     WhatsappUnknownContact (a number that has not been converted).
--  2. "OutboundMessage" mirrors that, because the outbound cron must be able
--     to reply on either thread type.
--  3. New "ChatReadState" table: per-USER read position, for unread counts.
--
-- WHY
-- Inbound WhatsApp from an unknown number is currently stored only as
-- counters on WhatsappUnknownContact (messageCount + firstMessageBody) - the
-- individual messages are DISCARDED (see the schema comment "bump
-- lastMessageAt and messageCount rather than creating new" rows). "Message"
-- required a leadId, so history for a non-lead number could not be written.
-- The product requirement is a WhatsApp inbox where a manager can read and
-- reply to BOTH known-lead and non-lead numbers in a normal chat window, so
-- the messages have to exist as rows.
--
-- WHY NOT the alternatives
--  * Auto-creating a Lead per inbound unknown number would reverse the
--    recorded T-E2b decision ("do NOT create Leads on unknown inbound") and
--    would fill the sales pipeline with spam.
--  * A separate Conversation table would need a data migration and would
--    fork the chat pane, the SSE chat:<id> channel, the media path and the
--    outbound cron into two implementations.
-- One nullable column pair gets both thread types through the SAME pane,
-- SSE channel, media path and outbound worker.
--
-- NOTE: this does NOT reverse T-E2b. Storing messages is not creating leads;
-- unknown numbers still stay in the WhatsApp triage queue until converted.
--
-- Hand-written rather than Prisma-generated, matching the convention of
-- 20260916092856_lead_project_required: `prisma migrate dev` emits FK
-- drop/recreate churn for the whole schema, which is unreviewable.

-- ── 1. Message: leadId nullable + contactId ─────────────────────────────────

ALTER TABLE "Message" ALTER COLUMN "leadId" DROP NOT NULL;
ALTER TABLE "Message" ADD COLUMN "contactId" TEXT;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "WhatsappUnknownContact"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Message_contactId_idx" ON "Message"("contactId");

-- Exactly one thread. A row pointing at both (or neither) would be
-- unreachable by BOTH query paths and invisible in the inbox - the failure
-- mode would be silent, so it is a hard constraint rather than app logic.
ALTER TABLE "Message"
  ADD CONSTRAINT "message_thread_exactly_one"
  CHECK (
    ("leadId" IS NOT NULL AND "contactId" IS NULL)
    OR ("leadId" IS NULL AND "contactId" IS NOT NULL)
  );

-- ── 2. OutboundMessage: leadId nullable + contactId ─────────────────────────

ALTER TABLE "OutboundMessage" ALTER COLUMN "leadId" DROP NOT NULL;
ALTER TABLE "OutboundMessage" ADD COLUMN "contactId" TEXT;

ALTER TABLE "OutboundMessage"
  ADD CONSTRAINT "OutboundMessage_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "WhatsappUnknownContact"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "OutboundMessage_contactId_idx" ON "OutboundMessage"("contactId");

ALTER TABLE "OutboundMessage"
  ADD CONSTRAINT "outbound_message_thread_exactly_one"
  CHECK (
    ("leadId" IS NOT NULL AND "contactId" IS NULL)
    OR ("leadId" IS NULL AND "contactId" IS NOT NULL)
  );

-- ── 3. ChatReadState ────────────────────────────────────────────────────────

CREATE TABLE "ChatReadState" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "leadId"     TEXT,
  "contactId"  TEXT,
  "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChatReadState_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ChatReadState"
  ADD CONSTRAINT "ChatReadState_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatReadState"
  ADD CONSTRAINT "ChatReadState_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatReadState"
  ADD CONSTRAINT "ChatReadState_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "WhatsappUnknownContact"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Same single-thread rule as Message.
ALTER TABLE "ChatReadState"
  ADD CONSTRAINT "chat_read_state_thread_exactly_one"
  CHECK (
    ("leadId" IS NOT NULL AND "contactId" IS NULL)
    OR ("leadId" IS NULL AND "contactId" IS NOT NULL)
  );

-- One read state per user per thread. Written as PARTIAL unique indexes
-- rather than a plain UNIQUE(userId, leadId, contactId): Postgres treats
-- NULLs as distinct, so a plain unique would permit unlimited duplicate rows
-- whenever one of the thread columns is NULL - which is always the case here.
CREATE UNIQUE INDEX "chat_read_state_user_lead_key"
  ON "ChatReadState"("userId", "leadId") WHERE "leadId" IS NOT NULL;

CREATE UNIQUE INDEX "chat_read_state_user_contact_key"
  ON "ChatReadState"("userId", "contactId") WHERE "contactId" IS NOT NULL;

CREATE INDEX "ChatReadState_userId_leadId_idx" ON "ChatReadState"("userId", "leadId");
CREATE INDEX "ChatReadState_userId_contactId_idx" ON "ChatReadState"("userId", "contactId");

-- ── 4. Pre-flight assertion: no existing row may violate the new rules ──────

DO $$
DECLARE bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
  FROM "Message"
  WHERE "leadId" IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Cannot migrate: % Message row(s) have no leadId and no contactId.', bad_count;
  END IF;

  SELECT count(*) INTO bad_count
  FROM "OutboundMessage"
  WHERE "leadId" IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Cannot migrate: % OutboundMessage row(s) have no leadId and no contactId.', bad_count;
  END IF;
END $$;
