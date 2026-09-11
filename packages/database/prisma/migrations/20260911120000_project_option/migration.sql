-- ProjectOption (2026-09-11): per-project facing/BHK option sets.
--
-- Facing and BHK were static UI constants; moving them into per-project
-- data lets each project define its own facing list and BHK range. One
-- table with a `type` discriminator (FACING | BHK) = one CRUD surface +
-- one RLS policy. `value` is a free-form string; BHK is converted to an
-- int when applied to a Unit.

-- CreateEnum
CREATE TYPE "ProjectOptionType" AS ENUM ('FACING', 'BHK');

-- CreateTable
CREATE TABLE "ProjectOption" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "ProjectOptionType" NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectOption_projectId_type_idx" ON "ProjectOption"("projectId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectOption_projectId_type_value_key" ON "ProjectOption"("projectId", "type", "value");

-- AddForeignKey
ALTER TABLE "ProjectOption" ADD CONSTRAINT "ProjectOption_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS (mirrors inventory_rls + phase_manager_write): SELECT is open to
-- every authenticated role (the pickers read it); INSERT/DELETE are
-- MANAGER/ADMIN/OWNER (OWNER travels as ADMIN at the RLS layer per the
-- locked Round-21 downcast). No UPDATE - a ProjectOption's value is
-- immutable (remove + re-add to change it).
GRANT SELECT, INSERT, UPDATE, DELETE ON "ProjectOption" TO shadhil_app;

ALTER TABLE "ProjectOption" ENABLE ROW LEVEL SECURITY;

CREATE POLICY projectoption_select_any_authenticated ON "ProjectOption"
  FOR SELECT
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC', 'CRON_SERVICE')
  );

CREATE POLICY projectoption_insert_manager ON "ProjectOption"
  FOR INSERT
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER'));

CREATE POLICY projectoption_delete_manager ON "ProjectOption"
  FOR DELETE
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'MANAGER'));
