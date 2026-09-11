-- T-ORG-CUID2 (2026-09-11): org ids must be VALID cuid2.
--
-- The bootstrap org row + every child row previously used the plaintext id
-- 'org_bootstrap'. z.cuid2() rejects it. Organization.id also defaulted to
-- cuid() (v1) instead of cuid2.
--
-- The child FKs are ON UPDATE NO ACTION, so we cannot simply UPDATE the
-- parent's id (children still reference the old id). FK-safe sequence:
--   1. INSERT a new Organization row with the target cuid2 id + a PLACEHOLDER
--      slug (the real slug belongs to the old row; slug is @unique).
--   2. Repoint every child table's organizationId -> the new id (now valid FK).
--   3. DELETE the old 'org_bootstrap' row (no child references it anymore).
--   4. Set the new row's slug to the canonical 'shadhil-builders'.
--
-- RLS note: org_* policies compare app.user_org_id == "Organization".id and
-- "<child>".organizationId. Because the rewrite is atomic and both sides move
-- together, org-scoped visibility is preserved (no rows lost / no leak).

BEGIN;

-- 1. Insert the new org row under a placeholder slug (slug is @unique;
--    the real slug is temporarily held by the old row).
INSERT INTO "Organization" ("id", name, slug, "createdAt", "updatedAt")
SELECT 'ceid01lpfe1esm8jwsxid41k28', name, '_bootstrap-mig-' || slug,
       "createdAt", "updatedAt"
FROM "Organization" WHERE "id" = 'org_bootstrap';

-- 2. Repoint every child table to the new org id. Each UPDATE is a no-op on
--    a fresh DB where no org_bootstrap rows exist.
UPDATE "Activity"               SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "AuditLog"               SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "Booking"                SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "Consent"                SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "Feedback"               SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "Lead"                   SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "ManagerAssignmentRule"  SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "Message"                SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "Notification"           SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "OutboundMessage"        SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "Phase"                  SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "Project"                SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "ProjectMember"          SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "ProjectOption"          SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "PushNotification"       SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "PushSubscription"       SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "Reminder"               SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "SiteVisit"              SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "StreamTicket"           SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "Team"                   SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "Unit"                   SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "User"                   SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "WebhookEvent"           SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';
UPDATE "WhatsappUnknownContact" SET "organizationId" = 'ceid01lpfe1esm8jwsxid41k28' WHERE "organizationId" = 'org_bootstrap';

-- 3. Delete the old org row (no children reference it now).
DELETE FROM "Organization" WHERE "id" = 'org_bootstrap';

-- 4. Restore the canonical slug on the new row.
UPDATE "Organization" SET slug = 'shadhil-builders' WHERE id = 'ceid01lpfe1esm8jwsxid41k28';

COMMIT;
