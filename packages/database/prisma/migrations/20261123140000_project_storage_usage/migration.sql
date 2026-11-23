-- ────────────────────────────────────────────────────────────────────────────
-- Site update video, step 5: a per-project byte ledger beside the per-org one
-- (2026-11-23).
--
-- WHY: a single org-wide cap lets one busy project spend every other project's
-- storage. Both limits are enforced at RECORD time by a conditional UPDATE
-- (usedBytes + size <= cap), so two concurrent records cannot both squeeze
-- under the line. The caps themselves are configuration, not columns: they come
-- from SITE_VIDEO_ORG_CAP_BYTES / SITE_VIDEO_PROJECT_CAP_BYTES, so changing a
-- limit never needs a migration.
--
-- Same RLS shape as "StorageUsage" (20261123120000): reads are org-scoped,
-- writes name the STAFF roles (a CUSTOMER must never advance a ledger that
-- enforces a cap), and the purge cron has its own arm demanding both GUCs.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE "ProjectStorageUsage" (
  "projectId"      TEXT   NOT NULL,
  "organizationId" TEXT   NOT NULL,
  "usedBytes"      BIGINT NOT NULL DEFAULT 0,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProjectStorageUsage_pkey" PRIMARY KEY ("projectId"),
  CONSTRAINT "ProjectStorageUsage_usedBytes_nonneg" CHECK ("usedBytes" >= 0)
);

ALTER TABLE "ProjectStorageUsage"
  ADD CONSTRAINT "ProjectStorageUsage_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectStorageUsage"
  ADD CONSTRAINT "ProjectStorageUsage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ProjectStorageUsage_organizationId_idx"
  ON "ProjectStorageUsage" ("organizationId");

-- A ledger can never go negative: the decrement path clamps, and this is the
-- backstop. (The org ledger shipped without it; its table is empty.)
ALTER TABLE "StorageUsage"
  ADD CONSTRAINT "StorageUsage_usedBytes_nonneg" CHECK ("usedBytes" >= 0);

GRANT SELECT, INSERT, UPDATE, DELETE ON "ProjectStorageUsage" TO shadhil_app;

ALTER TABLE "ProjectStorageUsage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectStorageUsage" FORCE ROW LEVEL SECURITY;

CREATE POLICY project_storage_usage_select_member ON "ProjectStorageUsage"
  FOR SELECT
  USING ("organizationId" = current_setting('app.user_org_id', true));

CREATE POLICY project_storage_usage_insert_staff ON "ProjectStorageUsage"
  FOR INSERT
  WITH CHECK (
    "organizationId" = current_setting('app.user_org_id', true)
    AND current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'ENGINEER', 'SALES_EXEC', 'TELECALLER')
  );

CREATE POLICY project_storage_usage_update_staff ON "ProjectStorageUsage"
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

CREATE POLICY project_storage_usage_cron_service ON "ProjectStorageUsage"
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
