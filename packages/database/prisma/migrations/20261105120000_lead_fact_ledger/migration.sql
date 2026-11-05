-- ────────────────────────────────────────────────────────────────────────────
-- T-LEAD-FACTS (2026-11-05): the lead fact ledger.
--
-- Design: docs/designs/lead-fact-ledger.md
-- Canonical policies: packages/database/prisma/rls/policies.sql (copied here
-- verbatim, per the migration policy in README.md §"Migration policy").
--
-- WHY A LEDGER AND NOT "JUST WRITE THE COLUMN"
-- Today any intake path writes Lead.name / Lead.email / Lead.source straight
-- from whatever the source said. A WhatsApp profile name is not the
-- customer's name; it is what they typed into their own phone. Once that
-- value is in the column nobody can tell it apart from a value a telecaller
-- verified on a call, so a wrong guess is indistinguishable from a fact.
--
-- This table keeps the observation, the evidence that priced it, and the
-- decision, separately:
--   * VERIFIED evidence (or a blank field) fills the Lead column.
--   * anything weaker waits as PROPOSED until a human accepts or dismisses.
--   * a value a human dismissed is never offered again.
--
-- RULE 7a: model + GRANTs + policies ship in this ONE migration so a fresh
-- `prisma migrate deploy` lands them atomically.
-- ────────────────────────────────────────────────────────────────────────────

-- ── 1. Enums ──
CREATE TYPE "FactBand" AS ENUM ('VERIFIED', 'PROBABLE', 'POSSIBLE');

CREATE TYPE "FactStatus" AS ENUM ('APPLIED', 'PROPOSED', 'DISMISSED', 'SUPERSEDED');

-- ── 2. LeadFact ──
CREATE TABLE "LeadFact" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "band" "FactBand" NOT NULL,
    "evidence" JSONB NOT NULL,
    "method" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "status" "FactStatus" NOT NULL DEFAULT 'PROPOSED',
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "LeadFact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LeadFact_leadId_field_status_idx" ON "LeadFact"("leadId", "field", "status");
CREATE INDEX "LeadFact_leadId_observedAt_idx" ON "LeadFact"("leadId", "observedAt");
CREATE INDEX "LeadFact_organizationId_idx" ON "LeadFact"("organizationId");
CREATE INDEX "LeadFact_status_idx" ON "LeadFact"("status");

ALTER TABLE "LeadFact"
  ADD CONSTRAINT "LeadFact_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeadFact"
  ADD CONSTRAINT "LeadFact_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The decision trail survives a user being removed; only the id goes.
ALTER TABLE "LeadFact"
  ADD CONSTRAINT "LeadFact_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. Table-level GRANTs (the app connects as the non-owner role) ──
GRANT SELECT, INSERT, UPDATE, DELETE ON "LeadFact" TO shadhil_app;

-- ── 4. RLS ──
ALTER TABLE "LeadFact" ENABLE ROW LEVEL SECURITY;

-- Same visibility rule as every other lead-scoped table (Activity, SiteVisit,
-- Message): org + a Lead the actor is allowed to see, resolved through
-- Team.managerId for MANAGER (multi-team) and owner/co-owner for staff.
-- ENGINEER deliberately has NO policy here: site staff see progress photos,
-- not leads.
CREATE POLICY lead_fact_select_team ON "LeadFact"
  FOR SELECT
  USING (
    "LeadFact"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "LeadFact"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'ADMIN')
          OR (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

CREATE POLICY lead_fact_insert_team ON "LeadFact"
  FOR INSERT
  WITH CHECK (
    "LeadFact"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "LeadFact"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  );

CREATE POLICY lead_fact_insert_admin ON "LeadFact"
  FOR INSERT
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "LeadFact"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
    )
  );

-- Accepting or dismissing a suggestion is an UPDATE on the row.
CREATE POLICY lead_fact_update_team ON "LeadFact"
  FOR UPDATE
  USING (
    "LeadFact"."organizationId" = current_setting('app.user_org_id', true)
    AND EXISTS (
      SELECT 1 FROM "Lead" l
      WHERE l.id = "LeadFact"."leadId"
        AND l."organizationId" = current_setting('app.user_org_id', true)
        AND (
          (current_setting('app.user_role', true) = 'MANAGER'
              AND EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = l."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              ))
          OR (current_setting('app.user_role', true) IN ('TELECALLER', 'SALES_EXEC')
              AND (
                l."ownerId" = current_setting('app.user_id', true)
                OR l."coOwnerId" = current_setting('app.user_id', true)
              ))
        )
    )
  )
  WITH CHECK (
    "LeadFact"."organizationId" = current_setting('app.user_org_id', true)
  );

CREATE POLICY lead_fact_update_admin ON "LeadFact"
  FOR UPDATE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );

-- Nothing in the product deletes a fact; a human dismisses one. DELETE exists
-- for admin tooling and for test cleanup, which runs as ADMIN. Without it,
-- `deleteMany` returns 0 with no error and rows leak across test runs.
CREATE POLICY lead_fact_delete_admin ON "LeadFact"
  FOR DELETE
  USING (
    current_setting('app.user_role', true) = 'ADMIN'
    AND "organizationId" = current_setting('app.user_org_id', true)
  );
