-- T-TOKEN-GATE (2026-09-29): make the token invariant a DATABASE rule.
--
-- WHY A CHECK CONSTRAINT, given the service already enforces this.
--
-- Three writes can reach "Booking" without passing the service:
--   * the webhook handler and one-off maintenance scripts use $executeRawUnsafe;
--   * psql (how the two bad figures in production got there);
--   * any future service method that forgets the guard.
-- Every service-level rule is bypassable by a raw write, so the invariant only
-- holds for the paths someone remembered to guard. A CHECK constraint holds for
-- ALL of them, including ones not written yet. That is the difference between
-- "new data is validated" and "new data is validated by the code we know about".
--
-- WHAT IT ENFORCES (deliberately weaker than the service, which is correct):
--   * tokenAmount IS NULL                 -> allowed (no token recorded yet)
--   * tokenAmount > 0 AND <= amount       -> allowed (a real part payment)
--   * tokenAmount = amount                -> allowed (a full payment IS a payment)
-- It does NOT require tokenAmount to be present when status is TOKEN/APPROVED.
-- That rule depends on the TRANSITION taken (a token may legitimately have been
-- recorded at HOLD time), which a row-level constraint cannot see - and a CHECK
-- that guessed would reject valid history. The service enforces presence; the
-- constraint enforces sanity.
--
-- NOT VALID first, then validate: NOT VALID applies the rule to NEW rows
-- immediately without scanning existing ones. That matters here because the two
-- known-bad rows (B-103, B-201) are dummy data and deliberately NOT being
-- repaired - a plain ADD CONSTRAINT would fail on them and block the migration
-- entirely. After the operator corrects the figures the constraint can be
-- validated in a follow-up migration:
--
--   ALTER TABLE "Booking" VALIDATE CONSTRAINT "booking_token_within_total";
--
-- UNTIL THEN the three historical rows stay unvalidated-but-present, which is
-- exactly the intended trade: new writes are constrained from now on, and the
-- known dummy rows are left alone rather than silently rewritten.

ALTER TABLE "Booking"
  ADD CONSTRAINT "booking_token_within_total"
  CHECK (
    "tokenAmount" IS NULL
    OR ("tokenAmount" > 0 AND "tokenAmount" <= "amount")
  )
  NOT VALID;

COMMENT ON CONSTRAINT "booking_token_within_total" ON "Booking" IS
  'T-TOKEN-GATE: a token is a PART payment, so it must be positive and cannot exceed the booking total. Enforced here because service-level guards are bypassable by raw SQL writes (webhooks, scripts, psql). NOT VALID so pre-existing dummy rows do not block the migration; VALIDATE after they are corrected.';
