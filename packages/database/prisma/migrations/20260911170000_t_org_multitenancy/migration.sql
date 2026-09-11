-- ────────────────────────────────────────────────────────────────────────────
-- T-ORG multitenancy (2026-09-11, eng review)
-- Adds an Organization tenant axis linked to all business data.
--
-- Strategy (hand-authored - Prisma can't express backfill/partial indexes):
--   1. Create Organization + seed one bootstrap org (idempotent on slug).
--   2. ADD COLUMN organizationId AS NULLABLE on every business table.
--   3. Backfill: lead-scoped tables from their Lead; user-scoped from User;
--      top-level & anonymous from the bootstrap org.
--   4. ALTER to NOT NULL + add FKs + indexes in one pass (per-table).
--   5. Replace the global `one_owner` partial index with per-org owners.
--
-- Runs via DIRECT_DATABASE_URL (owner role, bypasses RLS) so backfill UPDATEs
-- succeed. Idempotent: re-running on a fresh base is safe; the bootstrap org
-- insert is guarded by ON CONFLICT (slug), column-adds by IF NOT EXISTS.
-- ────────────────────────────────────────────────────────────────────────────

-- ── 1. Organization table + bootstrap org ─────────────────────────────────
CREATE TABLE "Organization" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "slug"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Organization_slug_idx" ON "Organization"("slug");

-- Seed the bootstrap org (idempotent). This is the tenant every pre-existing
-- row belongs to; real multi-org creation arrives with the org-bootstrap UI.
INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
SELECT 'org_bootstrap', 'Shadhil Builders', 'shadhil-builders', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Organization" WHERE "slug" = 'shadhil-builders');

-- ── 2 & 3 & 4. Per-table: add nullable column, backfill, lock to NOT NULL ──
-- We add every column as nullable first (so backfill UPDATEs don't hit NOT
-- NULL on empty/partial data), populate, then set NOT NULL + FK + index.

-- ── Team ───────────────────────────────────────────────────────────────────
ALTER TABLE "Team" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "Team" SET "organizationId" = 'org_bootstrap'
    WHERE "organizationId" IS NULL OR "organizationId" = '';
ALTER TABLE "Team" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Team" ADD CONSTRAINT "Team_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "Team_organizationId_idx" ON "Team"("organizationId");

-- ── ManagerAssignmentRule (parent team) ────────────────────────────────────
ALTER TABLE "ManagerAssignmentRule" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "ManagerAssignmentRule" r SET "organizationId" = t."organizationId"
    FROM "Team" t WHERE r."teamId" = t."id";
UPDATE "ManagerAssignmentRule" SET "organizationId" = 'org_bootstrap'
    WHERE "organizationId" IS NULL OR "organizationId" = '';
ALTER TABLE "ManagerAssignmentRule" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "ManagerAssignmentRule" ADD CONSTRAINT "ManagerAssignmentRule_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "ManagerAssignmentRule_organizationId_idx" ON "ManagerAssignmentRule"("organizationId");

-- ── Project (slug becomes per-org unique) ──────────────────────────────────
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "Project" SET "organizationId" = 'org_bootstrap' WHERE "organizationId" IS NULL;
ALTER TABLE "Project" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE UNIQUE INDEX "Project_organizationId_slug_key" ON "Project"("organizationId", "slug");
CREATE INDEX IF NOT EXISTS "Project_organizationId_idx" ON "Project"("organizationId");
-- drop the old global slug unique (replaced by per-org composite)
ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_slug_key";
DROP INDEX IF EXISTS "Project_slug_key";

-- ── ProjectMember ──────────────────────────────────────────────────────────
ALTER TABLE "ProjectMember" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "ProjectMember" m SET "organizationId" = p."organizationId"
    FROM "Project" p WHERE m."projectId" = p."id";
UPDATE "ProjectMember" SET "organizationId" = 'org_bootstrap'
    WHERE "organizationId" IS NULL OR "organizationId" = '';
ALTER TABLE "ProjectMember" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "ProjectMember_organizationId_idx" ON "ProjectMember"("organizationId");

-- ── Phase (parent project) ─────────────────────────────────────────────────
ALTER TABLE "Phase" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "Phase" ph SET "organizationId" = p."organizationId"
    FROM "Project" p WHERE ph."projectId" = p."id";
UPDATE "Phase" SET "organizationId" = 'org_bootstrap' WHERE "organizationId" IS NULL;
ALTER TABLE "Phase" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Phase" ADD CONSTRAINT "Phase_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "Phase_organizationId_idx" ON "Phase"("organizationId");

-- ── ProjectOption (parent project) ─────────────────────────────────────────
ALTER TABLE "ProjectOption" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "ProjectOption" o SET "organizationId" = p."organizationId"
    FROM "Project" p WHERE o."projectId" = p."id";
UPDATE "ProjectOption" SET "organizationId" = 'org_bootstrap' WHERE "organizationId" IS NULL;
ALTER TABLE "ProjectOption" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "ProjectOption" ADD CONSTRAINT "ProjectOption_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "ProjectOption_organizationId_idx" ON "ProjectOption"("organizationId");

-- ── Unit (parent phase) ─────────────────────────────────────────────────────
ALTER TABLE "Unit" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "Unit" u SET "organizationId" = ph."organizationId"
    FROM "Phase" ph WHERE u."phaseId" = ph."id";
UPDATE "Unit" SET "organizationId" = 'org_bootstrap' WHERE "organizationId" IS NULL;
ALTER TABLE "Unit" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "Unit_organizationId_idx" ON "Unit"("organizationId");

-- ── User (anchor; bootstrap org) ───────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "User" SET "organizationId" = 'org_bootstrap' WHERE "organizationId" IS NULL;
ALTER TABLE "User" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "User_organizationId_idx" ON "User"("organizationId");

-- ── Lead (anchor; bootstrap org in single-org) ─────────────────────────────
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "Lead" SET "organizationId" = 'org_bootstrap' WHERE "organizationId" IS NULL;
ALTER TABLE "Lead" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "Lead_organizationId_idx" ON "Lead"("organizationId");

-- ── Lead-scoped children: backfill from their Lead ─────────────────────────
ALTER TABLE "Activity" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "Activity" a SET "organizationId" = l."organizationId"
    FROM "Lead" l WHERE a."leadId" = l."id";
ALTER TABLE "Activity" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "Activity_organizationId_idx" ON "Activity"("organizationId");

ALTER TABLE "SiteVisit" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "SiteVisit" v SET "organizationId" = l."organizationId"
    FROM "Lead" l WHERE v."leadId" = l."id";
ALTER TABLE "SiteVisit" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "SiteVisit" ADD CONSTRAINT "SiteVisit_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "SiteVisit_organizationId_idx" ON "SiteVisit"("organizationId");

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "Message" m SET "organizationId" = l."organizationId"
    FROM "Lead" l WHERE m."leadId" = l."id";
ALTER TABLE "Message" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Message" ADD CONSTRAINT "Message_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "Message_organizationId_idx" ON "Message"("organizationId");

ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "Booking" b SET "organizationId" = l."organizationId"
    FROM "Lead" l WHERE b."leadId" = l."id";
ALTER TABLE "Booking" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "Booking_organizationId_idx" ON "Booking"("organizationId");

ALTER TABLE "Reminder" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "Reminder" r SET "organizationId" = l."organizationId"
    FROM "Lead" l WHERE r."leadId" = l."id";
ALTER TABLE "Reminder" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "Reminder_organizationId_idx" ON "Reminder"("organizationId");

ALTER TABLE "Consent" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "Consent" c SET "organizationId" = l."organizationId"
    FROM "Lead" l WHERE c."leadId" = l."id";
ALTER TABLE "Consent" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "Consent_organizationId_idx" ON "Consent"("organizationId");

ALTER TABLE "OutboundMessage" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "OutboundMessage" o SET "organizationId" = l."organizationId"
    FROM "Lead" l WHERE o."leadId" = l."id";
ALTER TABLE "OutboundMessage" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "OutboundMessage_organizationId_idx" ON "OutboundMessage"("organizationId");

-- ── User-scoped: backfill from their User ──────────────────────────────────
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "Notification" n SET "organizationId" = u."organizationId"
    FROM "User" u WHERE n."userId" = u."id";
UPDATE "Notification" SET "organizationId" = 'org_bootstrap'
    WHERE "organizationId" IS NULL OR "organizationId" = '';
ALTER TABLE "Notification" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "Notification_organizationId_idx" ON "Notification"("organizationId");

ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "PushSubscription" s SET "organizationId" = u."organizationId"
    FROM "User" u WHERE s."userId" = u."id";
UPDATE "PushSubscription" SET "organizationId" = 'org_bootstrap'
    WHERE "organizationId" IS NULL OR "organizationId" = '';
ALTER TABLE "PushSubscription" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "PushSubscription_organizationId_idx" ON "PushSubscription"("organizationId");

ALTER TABLE "PushNotification" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "PushNotification" n SET "organizationId" = u."organizationId"
    FROM "User" u WHERE n."userId" = u."id";
UPDATE "PushNotification" SET "organizationId" = 'org_bootstrap'
    WHERE "organizationId" IS NULL OR "organizationId" = '';
ALTER TABLE "PushNotification" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "PushNotification" ADD CONSTRAINT "PushNotification_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "PushNotification_organizationId_idx" ON "PushNotification"("organizationId");

-- ── AuditLog (nullable userId → fallback bootstrap) ────────────────────────
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "AuditLog" a SET "organizationId" = u."organizationId"
    FROM "User" u WHERE a."userId" = u."id";
UPDATE "AuditLog" SET "organizationId" = 'org_bootstrap'
    WHERE "organizationId" IS NULL OR "organizationId" = '';
ALTER TABLE "AuditLog" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "AuditLog_organizationId_idx" ON "AuditLog"("organizationId");

-- ── Feedback (public; bootstrap org until API-key org resolution lands) ─────
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "Feedback" SET "organizationId" = 'org_bootstrap' WHERE "organizationId" IS NULL;
ALTER TABLE "Feedback" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "Feedback_organizationId_idx" ON "Feedback"("organizationId");

-- ── WebhookEvent (org resolved at ingest; bootstrap for existing) ─────────
ALTER TABLE "WebhookEvent" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "WebhookEvent" SET "organizationId" = 'org_bootstrap' WHERE "organizationId" IS NULL;
ALTER TABLE "WebhookEvent" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "WebhookEvent_organizationId_idx" ON "WebhookEvent"("organizationId");

-- ── WhatsappUnknownContact (intentionally nullable - eng review Finding 3) ─
ALTER TABLE "WhatsappUnknownContact" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "WhatsappUnknownContact" ADD CONSTRAINT "WhatsappUnknownContact_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "WhatsappUnknownContact_organizationId_idx" ON "WhatsappUnknownContact"("organizationId");

-- ── StreamTicket (org carried from minting user - eng review Finding 2) ────
ALTER TABLE "StreamTicket" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
UPDATE "StreamTicket" t SET "organizationId" = u."organizationId"
    FROM "User" u WHERE t."userId" = u."id";
ALTER TABLE "StreamTicket" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "StreamTicket" ADD CONSTRAINT "StreamTicket_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "StreamTicket_organizationId_idx" ON "StreamTicket"("organizationId");

-- ── 5. OWNER uniqueness: global one_owner → per-org owner ───────────────────
-- The old partial unique index enforced EXACTLY ONE OWNER globally. Under
-- multi-tenancy each org owns exactly one org-owner (partial unique on
-- (organizationId) WHERE role='OWNER'). The OWNER role stays unassignable via
-- the API (users/roles.ts) - it is created by seed/migration only.
DROP INDEX IF EXISTS one_owner;
CREATE UNIQUE INDEX one_owner_per_org
    ON "User" ("organizationId")
    WHERE "role" = 'OWNER';
