-- ────────────────────────────────────────────────────────────────────────────
-- Consent.organizationId must be its lead's organisation (2026-11-26)
-- ────────────────────────────────────────────────────────────────────────────
-- WHY: TODOS.md recorded that both Consent INSERT policies compared the row to
-- the ACTOR's org and never to the LEAD's, so a consent row could be written
-- into a tenant its lead does not belong to. `consent_insert_owner` gained the
-- lead predicate in a later round; `consent_insert_admin` never did. And no
-- writer of any kind was stopped from storing a mismatched row, which matters
-- more than it sounds: the newest MARKETING row decides whether a buyer may be
-- mailed (site-update-consent.ts), so a row in the wrong tenant answers for the
-- wrong person.
--
-- ORDER MATTERS: the repair runs BEFORE the trigger exists. The trigger refuses
-- exactly the rows the UPDATE is fixing.
--
-- 1. REPAIR. A mismatched row is relinked to its lead's org, never deleted
-- (owner's decision, 2026-11-26): the ledger's whole value is that it survives
-- as evidence of what the buyer agreed to. No other column changes.
UPDATE "Consent" c
   SET "organizationId" = l."organizationId"
  FROM "Lead" l
 WHERE l."id" = c."leadId"
   AND l."organizationId" <> c."organizationId";

-- 2. The admin insert path gains the predicate `consent_insert_owner` already
-- carries, so an ADMIN cannot append a row to another org's lead either.
DROP POLICY IF EXISTS consent_insert_admin ON "Consent";
CREATE POLICY consent_insert_admin ON "Consent"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1
        FROM "Lead" l
       WHERE l."id" = "Consent"."leadId"
         AND l."organizationId" = current_setting('app.user_org_id', true)
    )
  );

-- 3. THE INVARIANT ITSELF. A policy only binds the app role, so the owner role
-- (BYPASSRLS: every seed, every script) could still write a mismatched row, and
-- so would any future writer that forgets the predicate. The trigger makes the
-- two columns structurally consistent for EVERY writer, including an UPDATE -
-- the table has no UPDATE path today, and the invariant should not depend on
-- that staying true.
--
-- SECURITY DEFINER so the Lead read does not depend on the app role's own
-- visibility: the caller may legitimately be unable to SELECT the lead whose
-- org is being verified, and a check that returns "not found" for a row that
-- exists would reject valid writes.
CREATE OR REPLACE FUNCTION consent_org_matches_lead() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org TEXT;
BEGIN
  SELECT "organizationId" INTO v_org FROM "Lead" WHERE "id" = NEW."leadId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consent.leadId % names no Lead', NEW."leadId"
      USING ERRCODE = '23503';
  END IF;
  IF NEW."organizationId" IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION
      'Consent.organizationId % is not its lead %''s org %',
      NEW."organizationId", NEW."leadId", v_org
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION consent_org_matches_lead() IS
  'T-CONSENT-ORG: a Consent row can only ever be stored under its lead''s organisation (2026-11-26).';

DROP TRIGGER IF EXISTS consent_org_matches_lead_trg ON "Consent";
CREATE TRIGGER consent_org_matches_lead_trg
  BEFORE INSERT OR UPDATE OF "organizationId", "leadId" ON "Consent"
  FOR EACH ROW
  EXECUTE FUNCTION consent_org_matches_lead();
