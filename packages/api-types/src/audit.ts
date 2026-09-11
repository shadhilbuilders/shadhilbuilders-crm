// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Audit module DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Every audit log entry is written inside a prisma.$transaction with the
// triggering action (eng review A2) - so failure rolls back the action.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * GET /api/audit query filter. Used by Admin/Manager to inspect activity.
 */
export const AuditLogQueryDtoSchema = z.object({
  userId: z.string().cuid2().optional(),
  entityType: z.string().optional(),
  entityId: z.string().cuid2().optional(),
  action: z.union([z.string(), z.array(z.string())]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type AuditLogQueryDto = z.infer<typeof AuditLogQueryDtoSchema>;

/**
 * Internal write shape used by the audit interceptor.
 * AuditInterceptor (or service-level prisma.$transaction) fills these in.
 */
export const AuditEntryDtoSchema = z.object({
  userId: z.string().cuid2(),
  action: z.string().min(1).max(200),
  entityType: z.string().min(1).max(80),
  entityId: z.string().cuid2().optional(),
  before: z.record(z.string(), z.unknown()).optional(),
  after: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().max(500).optional(),
  ipAddress: z.string().optional(),
  userAgent: z.string().max(500).optional(),
});
export type AuditEntryDto = z.infer<typeof AuditEntryDtoSchema>;
