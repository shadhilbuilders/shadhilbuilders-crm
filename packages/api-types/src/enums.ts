// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM — Enums (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Zod enum schemas for every Prisma model enum. The SAME Zod schema validates
// payloads in NestJS pipes AND Next.js route handlers, so a request rejected
// by the API is also rejected by the BFF before it hits the wire.
//
// Source of truth: packages/database/prisma/schema.prisma
// When Prisma adds/removes an enum value, update the matching Zod enum here
// in lockstep.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────────────
// Auth / RBAC
// ────────────────────────────────────────────────────────────────────────────

/** User role. Single primary role per user (A6) — no v1 role switching. */
export const RoleSchema = z.enum(['ADMIN', 'MANAGER', 'SALES_EXEC', 'TELECALLER']);
export type Role = z.infer<typeof RoleSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Lead module
// ────────────────────────────────────────────────────────────────────────────

/** Lead pipeline state (Model C state machine, IMPLEMENTATION-PLAN §3). */
export const LeadStateSchema = z.enum([
  'NEW',
  'CONTACTED',
  'VISIT_REQUESTED',
  'VISIT_SCHEDULED',
  'VISITED',
  'NEGOTIATION',
  'BOOKING_INITIATED',
  'WON',
  'LOST',
  'COLD',
  'RESCHEDULED',
  'NO_SHOW',
]);
export type LeadState = z.infer<typeof LeadStateSchema>;

/** Owning role for a lead. Used by RLS + ownership transitions. */
export const LeadOwnerTypeSchema = z.enum(['TELECALLER', 'SALES_EXEC', 'MANAGER', 'ADMIN']);
export type LeadOwnerType = z.infer<typeof LeadOwnerTypeSchema>;

/** Activity timeline entry type. STATUS_CHANGE auto-emitted by state machine. */
export const ActivityTypeSchema = z.enum(['CALL', 'NOTE', 'STATUS_CHANGE', 'VISIT', 'EMAIL']);
export type ActivityType = z.infer<typeof ActivityTypeSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Visit module
// ────────────────────────────────────────────────────────────────────────────

/** Site-visit status. RESCHEDULED spawns a new SiteVisit row. */
export const VisitStatusSchema = z.enum([
  'SCHEDULED',
  'RESCHEDULED',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
]);
export type VisitStatus = z.infer<typeof VisitStatusSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Chat module
// ────────────────────────────────────────────────────────────────────────────

/** Inbound = from customer. Outbound = from staff. */
export const MessageDirectionSchema = z.enum(['IN', 'OUT']);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

/** Channel the message traversed. WhatsApp carries externalId for dedup. */
export const MessageChannelSchema = z.enum(['WHATSAPP', 'IN_APP']);
export type MessageChannel = z.infer<typeof MessageChannelSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Bookings module
// ────────────────────────────────────────────────────────────────────────────

/** Booking lifecycle. HOLD → TOKEN → APPROVED is the happy path. */
export const BookingStatusSchema = z.enum([
  'HOLD',
  'TOKEN',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
]);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

/** Unit inventory state. */
export const UnitStatusSchema = z.enum(['AVAILABLE', 'HOLD', 'TOKEN', 'SOLD']);
export type UnitStatus = z.infer<typeof UnitStatusSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Reminders module
// ────────────────────────────────────────────────────────────────────────────

/** Reminder category. Cron processor uses type to pick delivery channel. */
export const ReminderTypeSchema = z.enum([
  'PRE_VISIT_STAFF',
  'PRE_VISIT_CUSTOMER',
  'RESCHEDULE_FOLLOWUP',
  'NO_SHOW_STAFF',
]);
export type ReminderType = z.infer<typeof ReminderTypeSchema>;

/** Reminder execution state. */
export const ReminderStatusSchema = z.enum(['SCHEDULED', 'SENT', 'FAILED', 'CANCELLED']);
export type ReminderStatus = z.infer<typeof ReminderStatusSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Push notifications
// ────────────────────────────────────────────────────────────────────────────

/** Target push platform. */
export const PushPlatformSchema = z.enum(['WEB', 'IOS', 'ANDROID']);
export type PushPlatform = z.infer<typeof PushPlatformSchema>;

/** Push delivery status. */
export const PushStatusSchema = z.enum(['PENDING', 'DELIVERED', 'FAILED']);
export type PushStatus = z.infer<typeof PushStatusSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Compliance (DPDP)
// ────────────────────────────────────────────────────────────────────────────

/** DPDP Act consent categories captured at lead creation. */
export const ConsentTypeSchema = z.enum(['MARKETING', 'DATA_PROCESSING', 'COMMUNICATION']);
export type ConsentType = z.infer<typeof ConsentTypeSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Webhooks
// ────────────────────────────────────────────────────────────────────────────

/** Inbound webhook source. */
export const WebhookSourceSchema = z.enum(['WHATSAPP', 'FREJUN']);
export type WebhookSource = z.infer<typeof WebhookSourceSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Convenience union — every enum schema, exported for runtime validation.
// ────────────────────────────────────────────────────────────────────────────

export const ALL_ENUM_SCHEMAS = {
  Role: RoleSchema,
  LeadState: LeadStateSchema,
  LeadOwnerType: LeadOwnerTypeSchema,
  ActivityType: ActivityTypeSchema,
  VisitStatus: VisitStatusSchema,
  MessageDirection: MessageDirectionSchema,
  MessageChannel: MessageChannelSchema,
  BookingStatus: BookingStatusSchema,
  UnitStatus: UnitStatusSchema,
  ReminderType: ReminderTypeSchema,
  ReminderStatus: ReminderStatusSchema,
  PushPlatform: PushPlatformSchema,
  PushStatus: PushStatusSchema,
  ConsentType: ConsentTypeSchema,
  WebhookSource: WebhookSourceSchema,
};
