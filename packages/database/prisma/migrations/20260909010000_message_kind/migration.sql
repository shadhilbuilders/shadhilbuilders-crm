-- T-CHAT-INTERNAL (2026-09-09): add Message.kind to split the per-lead
-- thread into CUSTOMER (staff<->customer, may enqueue WhatsApp) and
-- INTERNAL (staff-only notes, never reaches the customer).
--
-- Design (autoplan workstream B-minimal):
--   - New enum MessageKind { CUSTOMER, INTERNAL }.
--   - Message.kind column, default CUSTOMER so all existing rows stay
--     in the customer thread (no backfill needed).
--   - INTERNAL rows are always OUT/staff-authored (userId = actor) and
--     the send path skips the WhatsApp enqueue. RLS is unchanged: the
--     existing message_select_team / message_insert_team policies key off
--     the parent Lead, so internal notes inherit the same team/owner
--     scoping with no new policy.
--   - Room for future change: a targeted mention can add a recipientId
--     column later without touching this enum or the RLS.

CREATE TYPE "MessageKind" AS ENUM ('CUSTOMER', 'INTERNAL');

ALTER TABLE "Message" ADD COLUMN "kind" "MessageKind" NOT NULL DEFAULT 'CUSTOMER';
