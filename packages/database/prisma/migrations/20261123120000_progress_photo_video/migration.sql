-- ────────────────────────────────────────────────────────────────────────────
-- Site update video, step 1 of 8: schema + RLS in one migration (2026-11-23).
--
-- Plan: docs/plans/2026-11-23-site-update-video.md (approved by the autoplan
-- gate). Build sequence: docs/plans/2026-11-23-site-update-video-build-sequence.md
--
-- NOTHING HERE IS USER-VISIBLE. Steps 1 to 4 change no behaviour on purpose:
-- the risky structural work lands before a single pixel moves, so a schema
-- fault surfaces in a test rather than on a buyer's portal.
--
-- What this migration does:
--   1. ProgressPhoto.kind + the video columns, `key` widened to nullable so an
--      archived tombstone can outlive the bytes it describes.
--   2. The three invariants that stop a half-written row: a live video needs a
--      poster, a duration and a size; a duration sits in 1..45s; a size sits
--      under 14MiB. Plus: a row that is not archived must still have a key.
--   3. Unit.handoverCompletedAt, because retention runs from an ACTUAL handover
--      and an expected date is a guess.
--   4. StorageUsage (per-org byte ledger) and SiteUpdateDelivery (one row per
--      WhatsApp note), each with GRANT + ENABLE + FORCE RLS + policies.
--
-- WHY THE INDEXES ARE NOT `CONCURRENTLY` (deliberate deviation from the plan's
-- runbook): Prisma Migrate runs each migration file inside ONE transaction, and
-- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. The repo
-- already made this exact call once and documented it -
-- 20261118120000_user_phone_partial_unique/migration.sql:43-45 - for the same
-- reason. `ProgressPhoto` holds 13 rows on the dev database, so a plain
-- `CREATE UNIQUE INDEX` takes its SHARE lock for single-digit milliseconds.
-- If this table ever grows past a few hundred thousand rows, split the index
-- builds into their own non-transactional step before running this again.
--
-- CHECK constraints are added NOT VALID and validated in the same file, so the
-- scan behind VALIDATE never holds a lock on the table while it reads.
-- ────────────────────────────────────────────────────────────────────────────

-- ── 1. Enums ───────────────────────────────────────────────────────────────
CREATE TYPE "ProgressPhotoKind" AS ENUM ('PHOTO', 'VIDEO');
CREATE TYPE "SiteUpdateDeliveryStatus" AS ENUM (
  'PENDING',
  'SENT',
  'SKIPPED_WINDOW',
  'SKIPPED_NO_TEMPLATE',
  'FAILED'
);

-- ── 2. ProgressPhoto: kind + video columns ─────────────────────────────────
-- `kind` uses NOT NULL DEFAULT, which Postgres 11+ performs as a metadata-only
-- change: no rewrite, no backfill, and every existing row is a PHOTO.
-- `key` loses NOT NULL because the purge path clears keys after deleting the
-- objects; the CHECK below keeps that widening from letting a live row drift
-- into a keyless state.
ALTER TABLE "ProgressPhoto"
  ADD COLUMN "kind"       "ProgressPhotoKind" NOT NULL DEFAULT 'PHOTO',
  ADD COLUMN "sizeBytes"  INTEGER,
  ADD COLUMN "durationMs" INTEGER,
  ADD COLUMN "posterKey"  TEXT,
  ADD COLUMN "batchId"    TEXT,
  ADD COLUMN "uploadId"   TEXT,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "hasAudio"   BOOLEAN NOT NULL DEFAULT false,
  ALTER COLUMN "key" DROP NOT NULL;

-- ── 3. Unit: the date retention counts from ────────────────────────────────
ALTER TABLE "Unit" ADD COLUMN "handoverCompletedAt" TIMESTAMP(3);

-- ── 4. Indexes ─────────────────────────────────────────────────────────────
-- The two object-key indexes are per organisation. NULLs are exempt in a
-- Postgres unique index, so photo rows (posterKey null) never collide, and an
-- archived row whose keys are cleared is unconstrained - which is what we want.
-- They do NOT stop a video's posterKey equalling another row's key; separate
-- indexes cannot express that, and the delete path plus the daily orphan sweep
-- handle the overlap (stated in the plan rather than claimed as a guarantee).
CREATE UNIQUE INDEX "ProgressPhoto_organizationId_key_key"
  ON "ProgressPhoto" ("organizationId", "key");
CREATE UNIQUE INDEX "ProgressPhoto_organizationId_posterKey_key"
  ON "ProgressPhoto" ("organizationId", "posterKey");
-- A retried upload of the same take replays its row instead of duplicating it.
CREATE UNIQUE INDEX "ProgressPhoto_organizationId_unitId_uploadId_key"
  ON "ProgressPhoto" ("organizationId", "unitId", "uploadId");
-- One note = one WhatsApp message; the delivery row and the batch lookup both
-- start from this.
CREATE INDEX "ProgressPhoto_organizationId_batchId_idx"
  ON "ProgressPhoto" ("organizationId", "batchId");

-- ── 5. Invariants ──────────────────────────────────────────────────────────
-- A LIVE video carries a poster, a duration and a size. A tombstone
-- (archivedAt set) may carry none of them, because the purge clears them.
ALTER TABLE "ProgressPhoto" ADD CONSTRAINT "ProgressPhoto_video_requires_poster"
  CHECK (
    "kind" <> 'VIDEO'
    OR ("posterKey" IS NOT NULL AND "durationMs" IS NOT NULL AND "sizeBytes" IS NOT NULL)
    OR "archivedAt" IS NOT NULL
  ) NOT VALID;

-- The 45s ceiling lives in the database too, not only in the API and UI: one
-- number, enforced in three places, is what makes the WhatsApp budget real.
ALTER TABLE "ProgressPhoto" ADD CONSTRAINT "ProgressPhoto_duration_range"
  CHECK ("durationMs" IS NULL OR "durationMs" BETWEEN 1000 AND 45000) NOT VALID;

-- 14MiB = 14680064 bytes, under Meta's 16MB video ceiling and above a 45s clip
-- at 2.5 Mbps (13.61 MB measured).
ALTER TABLE "ProgressPhoto" ADD CONSTRAINT "ProgressPhoto_size_cap"
  CHECK ("sizeBytes" IS NULL OR "sizeBytes" BETWEEN 0 AND 14680064) NOT VALID;

-- Keyless rows exist only as tombstones. Without this, the nullable `key` above
-- would silently allow a live row that no reader can render.
ALTER TABLE "ProgressPhoto" ADD CONSTRAINT "ProgressPhoto_key_required_unless_archived"
  CHECK ("key" IS NOT NULL OR "archivedAt" IS NOT NULL) NOT VALID;

ALTER TABLE "ProgressPhoto" VALIDATE CONSTRAINT "ProgressPhoto_video_requires_poster";
ALTER TABLE "ProgressPhoto" VALIDATE CONSTRAINT "ProgressPhoto_duration_range";
ALTER TABLE "ProgressPhoto" VALIDATE CONSTRAINT "ProgressPhoto_size_cap";
ALTER TABLE "ProgressPhoto" VALIDATE CONSTRAINT "ProgressPhoto_key_required_unless_archived";

-- ── 6. StorageUsage (one row per organisation) ─────────────────────────────
-- The per-org video cap is a sentence without this table. `usedBytes` moves
-- from the SERVER-verified size, `reservedBytes` is the advisory in-flight
-- amount held while a signed upload is open (a 600s token lets the browser
-- re-upload with no server in the loop, so the pre-signing check is guidance
-- and the record-time check is the limit).
CREATE TABLE "StorageUsage" (
  "organizationId" TEXT    NOT NULL,
  "usedBytes"      BIGINT  NOT NULL DEFAULT 0,
  "reservedBytes"  BIGINT  NOT NULL DEFAULT 0,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "StorageUsage_pkey" PRIMARY KEY ("organizationId")
);

ALTER TABLE "StorageUsage"
  ADD CONSTRAINT "StorageUsage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 7. SiteUpdateDelivery (one row per note) ───────────────────────────────
-- Keyed by batch, not by file: a note with three photos and a clip is ONE
-- WhatsApp message, and a retried send must not become two.
CREATE TABLE "SiteUpdateDelivery" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "batchId"        TEXT NOT NULL,
  "unitId"         TEXT NOT NULL,
  "status"         "SiteUpdateDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "templateName"   TEXT,
  "wamid"          TEXT,
  "errorCode"      TEXT,
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "sentAt"         TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SiteUpdateDelivery_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SiteUpdateDelivery"
  ADD CONSTRAINT "SiteUpdateDelivery_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SiteUpdateDelivery"
  ADD CONSTRAINT "SiteUpdateDelivery_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "Unit"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "SiteUpdateDelivery_organizationId_batchId_key"
  ON "SiteUpdateDelivery" ("organizationId", "batchId");
CREATE INDEX "SiteUpdateDelivery_organizationId_status_createdAt_idx"
  ON "SiteUpdateDelivery" ("organizationId", "status", "createdAt");

-- ── 8. Table-level GRANTs ──────────────────────────────────────────────────
-- Rule from issue #7 slice 1: model + GRANTs + policies in ONE migration. A new
-- table without its grant inserts nothing, silently.
GRANT SELECT, INSERT, UPDATE, DELETE ON "StorageUsage" TO shadhil_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "SiteUpdateDelivery" TO shadhil_app;

-- ── 9. RLS: ENABLE + FORCE ─────────────────────────────────────────────────
-- FORCE is what makes the policies bind the table OWNER too. Without it, a
-- connection that happens to arrive as the migration role bypasses everything.
ALTER TABLE "StorageUsage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StorageUsage" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SiteUpdateDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SiteUpdateDelivery" FORCE ROW LEVEL SECURITY;

-- ── 10. StorageUsage policies ──────────────────────────────────────────────
-- READ is org-scoped: the ledger backs a visible cap indicator and discloses
-- nothing about another person's data, so every role in the org may see it.
--
-- WRITE is STAFF-only. The first draft scoped the write arms to the
-- organisation alone, and the step-1 proof suite showed what that admits: a
-- CUSTOMER login, and any actor holding the CRON_SERVICE marker with a real
-- user id, could advance `usedBytes`. The per-org cap is enforced by this
-- ledger, so a buyer could hand themselves unlimited storage by being in the
-- org. The repo already states the rule this violated: "NO WRITE ARM EXISTS FOR
-- CUSTOMER ON ANY TABLE" (20261106160000_customer_portal_slice2:38).
--
-- CRON_SERVICE and the other GUC-only markers are named nowhere in the staff
-- list on purpose. They are not staff roles; the cron has its own arm below,
-- which demands BOTH the role and the sentinel user id, so admitting the marker
-- here as well would let a forged role borrow a real user's id.
CREATE POLICY storage_usage_select_member ON "StorageUsage"
  FOR SELECT
  USING ("organizationId" = current_setting('app.user_org_id', true));

CREATE POLICY storage_usage_insert_staff ON "StorageUsage"
  FOR INSERT
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'ENGINEER', 'SALES_EXEC', 'TELECALLER')
  );

CREATE POLICY storage_usage_update_staff ON "StorageUsage"
  FOR UPDATE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'ENGINEER', 'SALES_EXEC', 'TELECALLER')
  )
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'ENGINEER', 'SALES_EXEC', 'TELECALLER')
  );

-- The purge cron decrements usage after deleting bytes. Both GUCs are required:
-- a caller who forges the role but keeps their own user id falls through and is
-- denied (same impersonation guard as reminder_cron_service).
CREATE POLICY storage_usage_cron_service ON "StorageUsage"
  FOR ALL
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND current_setting('app.user_id', true) = 'cron-service'
  )
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND current_setting('app.user_id', true) = 'cron-service'
  );

-- ── 11. SiteUpdateDelivery policies ────────────────────────────────────────
-- Same membership join ProgressPhoto uses: Unit has no projectId, so the
-- project resolves through Phase, and membership is ProjectTeam -> TeamMember
-- or the linked team's manager. ADMIN is org-wide. An ENGINEER additionally has
-- to hold the villa (assignedEngineerId), matching the 2026-11-10 assignment
-- scoping rather than the looser team-membership arm.
--
-- Every write arm names the STAFF roles explicitly. A membership join alone
-- would admit a CUSTOMER who was added to a team by mistake, and the GUC-only
-- markers (CRON_SERVICE, PUBLIC_API, INVITE_ACCEPT) are not staff at all - the
-- cron has its own arm, which demands both the role and the sentinel user id.
CREATE POLICY site_update_delivery_select_member ON "SiteUpdateDelivery"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR (
        current_setting('app.user_role', true) IN
          ('MANAGER', 'ENGINEER', 'SALES_EXEC', 'TELECALLER')
        AND EXISTS (
          SELECT 1
          FROM "Unit" u
          JOIN "Phase" ph ON ph."id" = u."phaseId"
          JOIN "ProjectTeam" pt ON pt."projectId" = ph."projectId"
          WHERE u."id" = "SiteUpdateDelivery"."unitId"
            AND pt."organizationId" = current_setting('app.user_org_id', true)
            AND (
              current_setting('app.user_role', true) <> 'ENGINEER'
              OR u."assignedEngineerId" = current_setting('app.user_id', true)
            )
            AND (
              EXISTS (
                SELECT 1 FROM "TeamMember" tm
                WHERE tm."teamId" = pt."teamId"
                  AND tm."userId" = current_setting('app.user_id', true)
              )
              OR EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = pt."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              )
            )
        )
      )
    )
  );

-- INSERT: the same member arm. The delivery row is written by whoever recorded
-- the update, so no separate creator binding is needed - unit membership is the
-- binding, and the org check is fail-closed for a NULL org GUC.
CREATE POLICY site_update_delivery_insert_member ON "SiteUpdateDelivery"
  FOR INSERT
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND (
      current_setting('app.user_role', true) = 'ADMIN'
      OR (
        current_setting('app.user_role', true) IN
          ('MANAGER', 'ENGINEER', 'SALES_EXEC', 'TELECALLER')
        AND EXISTS (
          SELECT 1
          FROM "Unit" u
          JOIN "Phase" ph ON ph."id" = u."phaseId"
          JOIN "ProjectTeam" pt ON pt."projectId" = ph."projectId"
          WHERE u."id" = "SiteUpdateDelivery"."unitId"
            AND pt."organizationId" = current_setting('app.user_org_id', true)
            AND (
              current_setting('app.user_role', true) <> 'ENGINEER'
              OR u."assignedEngineerId" = current_setting('app.user_id', true)
            )
            AND (
              EXISTS (
                SELECT 1 FROM "TeamMember" tm
                WHERE tm."teamId" = pt."teamId"
                  AND tm."userId" = current_setting('app.user_id', true)
              )
              OR EXISTS (
                SELECT 1 FROM "Team" t
                WHERE t."id" = pt."teamId"
                  AND t."managerId" = current_setting('app.user_id', true)
              )
            )
        )
      )
    )
  );

-- UPDATE is the send path (status, wamid, attempts) and the cron's claim. It is
-- ROLE-scoped rather than villa-scoped so a status flip never depends on the
-- villa still being assigned to the person who sent it, and STAFF-scoped rather
-- than org-scoped because a buyer has no business marking a delivery SENT.
CREATE POLICY site_update_delivery_update_staff ON "SiteUpdateDelivery"
  FOR UPDATE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'ENGINEER', 'SALES_EXEC', 'TELECALLER')
  )
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'ENGINEER', 'SALES_EXEC', 'TELECALLER')
  );

-- DELETE is an admin-class concern (cleanup of a bad batch), never a member one.
CREATE POLICY site_update_delivery_delete_admin ON "SiteUpdateDelivery"
  FOR DELETE
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'ADMIN'
  );

-- The cron claim: both GUCs required, exactly like reminder_cron_service. The
-- delivery row is claimed by the outbound job under
-- withRlsContext({ userId: 'cron-service', role: 'CRON_SERVICE' }).
CREATE POLICY site_update_delivery_cron_service ON "SiteUpdateDelivery"
  FOR ALL
  USING (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND current_setting('app.user_id', true) = 'cron-service'
  )
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) = 'CRON_SERVICE'
    AND current_setting('app.user_id', true) = 'cron-service'
  );
