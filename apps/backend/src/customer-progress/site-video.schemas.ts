// Request schemas for the site update video routes (plan section 8).
//
// Deliberately absent: `mimeType`. The bytes decide the type, so there is no
// field for a client to lie in. `sizeBytes` IS present, but only as a claim the
// server compares against its own `stat`; a mismatch is an error, never trusted.
import { ConstructionStageSchema } from '@shadhil/api-types';
import { z } from 'zod';

import { UPLOAD_ID_PATTERN } from './site-video-upload-id';

const BATCH_ID = /^[A-Za-z0-9_-]{8,64}$/;
const STORAGE_KEY_MAX = 512;

/** Hard ceiling in the schema is generous so a too-long clip gets VIDEO_TOO_LONG, not a bare 400. */
const DURATION_MS_SCHEMA_CEILING = 10 * 60 * 1000;

export const MAX_VIDEO_DURATION_MS = 45_000;
export const MIN_VIDEO_DURATION_MS = 1_000;

export const RecordVideoSchema = z.object({
  uploadId: z.string().regex(UPLOAD_ID_PATTERN, 'uploadId is not a valid upload id'),
  key: z.string().min(1).max(STORAGE_KEY_MAX),
  posterKey: z.string().min(1).max(STORAGE_KEY_MAX),
  batchId: z.string().regex(BATCH_ID, 'batchId must be 8-64 letters, digits, - or _'),
  phaseId: z.string().cuid2(),
  sizeBytes: z.number().int().positive(),
  durationMs: z.number().int().min(MIN_VIDEO_DURATION_MS).max(DURATION_MS_SCHEMA_CEILING),
  hasAudio: z.boolean(),
  // ISO 8601 WITH offset, same rule as the photo route: ordering across devices
  // depends on the offset.
  takenAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid datetime')
    .refine((s) => /(?:Z|[+-]\d{2}:?\d{2})$/.test(s.trim()), 'takenAt must carry a UTC offset'),
  caption: z.string().trim().min(1).max(200).optional(),
  stage: ConstructionStageSchema.optional(),
});
export type RecordVideoDto = z.infer<typeof RecordVideoSchema>;

/** Inline (local-disk) upload of one object into a server-issued folder. */
export const InlineUploadSchema = z.object({
  slot: z.enum(['clip', 'poster']),
  base64: z.string().min(1),
});
export type InlineUploadDto = z.infer<typeof InlineUploadSchema>;
