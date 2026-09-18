-- RECONCILE (2026-09-18): the org-multitenancy FK/updatedAt drift.
--
-- WHY THIS EXISTS
-- ---------------
-- `prisma migrate dev` had refused to generate ANY migration for months
-- ("The migration 20260911210000_t_org_grant_and_rls was modified after it was
-- applied"), and once reconciled it produced a 47-statement migration that
-- bundled this drift with whatever change was actually requested. That is how a
-- one-column addition turned into a 143-line diff touching ~40 foreign keys.
-- This migration pays the drift down once so future migrations are minimal.
--
-- TWO DISTINCT PROBLEMS, both verified against the live DB before writing:
--
-- 1. FK `ON UPDATE` actions. `20260911170000_t_org_multitenancy` is
--    HAND-WRITTEN, so its `ADD CONSTRAINT ... REFERENCES "Organization"("id")
--    ON DELETE ...` clauses omit `ON UPDATE`, which Postgres defaults to
--    NO ACTION. Prisma's emitter always writes ON UPDATE CASCADE, so
--    `migrate diff` saw 23 FKs as permanently out of sync and wanted to
--    DROP + re-ADD every one on every future migration.
--    (ProjectTeam and TeamMember already had CASCADE - those came from a
--    Prisma-generated migration, which is exactly the difference.)
--    Fix: re-add the 23 with ON UPDATE CASCADE so the DB matches what Prisma
--    would emit. ON DELETE is preserved exactly as-is (mixed RESTRICT/CASCADE/
--    SET NULL per the schema) - only the update action changes.
--
-- 2. `Organization.updatedAt` had a DB-level DEFAULT. The schema declares
--    `updatedAt DateTime @updatedAt` with NO @default, so Prisma sets the value
--    client-side and the DB default was leftover from scaffold.
--    Verified safe: nothing INSERTs into "Organization" via raw SQL (the only
--    writer is a typed `prisma.organization.create`, which supplies the value).
--
-- WHY RE-ADDING AN FK IS SAFE HERE: each constraint is dropped and re-added on
-- a validated table with existing data. Postgres re-checks the constraint on
-- ADD, and since the referenced/referencing keys are unchanged, it validates.
-- No column or row is touched.

-- 1. Organization.updatedAt - drop the stray DB default.
ALTER TABLE "Organization" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- 2. Re-add the 23 organizationId FKs with ON UPDATE CASCADE.
--    AuditLog
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_organizationId_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Booking
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_organizationId_fkey";
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Lead
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_organizationId_fkey";
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Team
ALTER TABLE "Team" DROP CONSTRAINT "Team_organizationId_fkey";
ALTER TABLE "Team" ADD CONSTRAINT "Team_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- User
ALTER TABLE "User" DROP CONSTRAINT "User_organizationId_fkey";
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Activity
ALTER TABLE "Activity" DROP CONSTRAINT "Activity_organizationId_fkey";
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Consent
ALTER TABLE "Consent" DROP CONSTRAINT "Consent_organizationId_fkey";
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Feedback
ALTER TABLE "Feedback" DROP CONSTRAINT "Feedback_organizationId_fkey";
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- ManagerAssignmentRule
ALTER TABLE "ManagerAssignmentRule" DROP CONSTRAINT "ManagerAssignmentRule_organizationId_fkey";
ALTER TABLE "ManagerAssignmentRule" ADD CONSTRAINT "ManagerAssignmentRule_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Message
ALTER TABLE "Message" DROP CONSTRAINT "Message_organizationId_fkey";
ALTER TABLE "Message" ADD CONSTRAINT "Message_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Notification
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_organizationId_fkey";
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- OutboundMessage
ALTER TABLE "OutboundMessage" DROP CONSTRAINT "OutboundMessage_organizationId_fkey";
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Phase
ALTER TABLE "Phase" DROP CONSTRAINT "Phase_organizationId_fkey";
ALTER TABLE "Phase" ADD CONSTRAINT "Phase_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Project
ALTER TABLE "Project" DROP CONSTRAINT "Project_organizationId_fkey";
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- ProjectOption
ALTER TABLE "ProjectOption" DROP CONSTRAINT "ProjectOption_organizationId_fkey";
ALTER TABLE "ProjectOption" ADD CONSTRAINT "ProjectOption_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- PushNotification
ALTER TABLE "PushNotification" DROP CONSTRAINT "PushNotification_organizationId_fkey";
ALTER TABLE "PushNotification" ADD CONSTRAINT "PushNotification_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- PushSubscription
ALTER TABLE "PushSubscription" DROP CONSTRAINT "PushSubscription_organizationId_fkey";
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Reminder
ALTER TABLE "Reminder" DROP CONSTRAINT "Reminder_organizationId_fkey";
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SiteVisit
ALTER TABLE "SiteVisit" DROP CONSTRAINT "SiteVisit_organizationId_fkey";
ALTER TABLE "SiteVisit" ADD CONSTRAINT "SiteVisit_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- StreamTicket
ALTER TABLE "StreamTicket" DROP CONSTRAINT "StreamTicket_organizationId_fkey";
ALTER TABLE "StreamTicket" ADD CONSTRAINT "StreamTicket_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Unit
ALTER TABLE "Unit" DROP CONSTRAINT "Unit_organizationId_fkey";
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- WebhookEvent
ALTER TABLE "WebhookEvent" DROP CONSTRAINT "WebhookEvent_organizationId_fkey";
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- WhatsappUnknownContact (SET NULL on delete, per schema)
ALTER TABLE "WhatsappUnknownContact" DROP CONSTRAINT "WhatsappUnknownContact_organizationId_fkey";
ALTER TABLE "WhatsappUnknownContact" ADD CONSTRAINT "WhatsappUnknownContact_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
