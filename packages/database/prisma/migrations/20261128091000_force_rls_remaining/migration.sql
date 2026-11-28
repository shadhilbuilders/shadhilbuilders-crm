-- AR-1 (2026-08-31) said every policy table is FORCEd. On 2026-11-28, seven were
-- not: RLS was enabled, FORCE was off. The catalogue (prisma/rls/policies.sql)
-- had grown the statements for some of these and the applied migrations had not,
-- which is exactly the drift a catalogue-only claim invites.
--
-- Read honestly, this migration does NOT close the exposure people assume it
-- closes: the table owner `shadhil` is SUPERUSER with BYPASSRLS on both dev and
-- prod, and a superuser ignores FORCE. So today any owner-role connection reads
-- every table unfiltered, forced or not. What this buys is that the invariant is
-- true, so the day the owner stops being superuser the tables are already held.
-- See TODOS.md for the role change that would make FORCE bite.
--
-- The seed writes ProjectOption and ProjectStaffRole through the owner role. It
-- keeps working while the owner is superuser; if that changes, the seed has to
-- set the GUCs or run as an admin actor.
ALTER TABLE "Feedback" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LeadFact" FORCE ROW LEVEL SECURITY;
ALTER TABLE "OutboundMessage" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ProgressPhoto" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ProjectOption" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ProjectStaffRole" FORCE ROW LEVEL SECURITY;
ALTER TABLE "WhatsappUnknownContact" FORCE ROW LEVEL SECURITY;
