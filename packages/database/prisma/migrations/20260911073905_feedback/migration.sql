/*
  Feedback (2026-09-11): public customer-feedback submissions from the
  landing page (app/feedback). The landing page calls
  POST /api/public/feedback (public, API-key-gated) which inserts into this
  table - so feedback now lands in the CRM database instead of Supabase.

  The model is standalone (no FK) by design: the submitter is a site
  visitor, and `project` is a free-form landing-page slug, not a Project id.

  The auto-generated diff also swept in two PRE-EXISTING schema/DB drifts
  unrelated to this feature (ProjectMember.role stored as text-vs-Role enum,
  and a truncated ManagerAssignmentRule index name). Those are deliberately
  NOT included here - they belong to a separate out-of-band migration fix and
  must not ride along with the feedback model.
*/
-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('NEW', 'REVIEWED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "rating" INTEGER NOT NULL,
    "project" TEXT,
    "message" TEXT,
    "page" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "status" "FeedbackStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- rating is 1-5; enforced at the DB layer (belt) in addition to the
-- public DTO's Zod min/max (suspenders).
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_rating_check" CHECK ("rating" >= 1 AND "rating" <= 5);

-- CreateIndex
CREATE INDEX "Feedback_status_idx" ON "Feedback"("status");
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt");
CREATE INDEX "Feedback_rating_idx" ON "Feedback"("rating");

-- ────────────────────────────────────────────────────────────────────────────
-- RLS + grants (same pattern as project_option / booking_admin_write:
-- the GRANT + policies live in the migration, not the legacy consolidated
-- policies.sql doc, which has drifted out of sync with recent migrations).
--
-- The public submitter is NOT a staff user and carries no JWT. A dedicated
-- service marker `PUBLIC_API` (mirroring CRON_SERVICE) is set as
-- app.user_role by the public endpoint's withRlsContext, so the anonymous
-- insert passes RLS without faking a staff identity. PUBLIC_API gets INSERT
-- only - it can never read or mutate feedback.
--
-- Admin triage (GET /api/feedback, PATCH /api/feedback/:id) is ADMIN-class
-- only (ADMIN + OWNER, OWNER downcasts to ADMIN at the RLS layer). Managers
-- and staff see no feedback rows.
-- ────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON "Feedback" TO shadhil_app;

ALTER TABLE "Feedback" ENABLE ROW LEVEL SECURITY;

-- Public API: insert-only bypass for the anonymous landing-page endpoint.
CREATE POLICY feedback_insert_public_api ON "Feedback"
  FOR INSERT
  WITH CHECK (current_setting('app.user_role', true) = 'PUBLIC_API');

-- Admin read (list + detail). ADMIN travels for OWNER per the locked
-- Round-21 downcast in withRlsContext.
CREATE POLICY feedback_select_admin ON "Feedback"
  FOR SELECT
  USING (current_setting('app.user_role', true) = 'ADMIN');

-- Admin status triage (NEW -> REVIEWED -> ARCHIVED). The ONLY update.
CREATE POLICY feedback_update_admin ON "Feedback"
  FOR UPDATE
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');
