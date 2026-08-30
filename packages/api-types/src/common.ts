// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM — Common DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// Shared pagination, error envelopes, ID param schemas. Used by every
// NestJS controller and Next.js route handler.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/** Standard pagination for list endpoints. */
export const PaginationDtoSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type PaginationDto = z.infer<typeof PaginationDtoSchema>;

/** Cuid path param. */
export const IdParamDtoSchema = z.object({ id: z.string().cuid() });
export type IdParamDto = z.infer<typeof IdParamDtoSchema>;

/** Standard error response envelope. */
export const ErrorResponseDtoSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string().optional(),
});
export type ErrorResponseDto = z.infer<typeof ErrorResponseDtoSchema>;

/** ISO datetime string. */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

/** Standard success response wrapper. */
export const OkResponseSchema = z.object({
  ok: z.literal(true),
  data: z.unknown().optional(),
});
export type OkResponse = z.infer<typeof OkResponseSchema>;
