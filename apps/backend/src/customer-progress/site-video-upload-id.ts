// Server-issued upload ids (2026-11-23).
//
// The record, inline-upload and cancel routes all trust the upload folder
// `/<organizationId>/<uploadId>/`. If the client could choose its own uploadId
// it could point a record at a folder holding someone else's pending clip, or
// overwrite one through the inline route. So the id is `nonce || mac`, where the
// MAC binds the nonce to (organisation, unit, user) under a key derived from
// JWT_SECRET with a domain-separation label. A forged, foreign or tampered id
// fails verification without any server-side storage of issued ids.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const NONCE_BYTES = 16;
const MAC_HEX_CHARS = 32;
const LABEL = 'shadhil:site-video-upload-id:v1';

/** Hex nonce (32) + hex MAC (32) = 64 chars. */
export const UPLOAD_ID_PATTERN = /^[0-9a-f]{64}$/;

export interface UploadScope {
  organizationId: string;
  unitId: string;
  userId: string;
}

function macFor(nonceHex: string, scope: UploadScope, secret: string): string {
  const key = createHmac('sha256', secret).update(LABEL).digest();
  return createHmac('sha256', key)
    .update(`${nonceHex}\n${scope.organizationId}\n${scope.unitId}\n${scope.userId}`)
    .digest('hex')
    .slice(0, MAC_HEX_CHARS);
}

function requireSecret(secret: string | undefined): string {
  if (secret === undefined || secret.length < 16) {
    throw new Error('JWT_SECRET is required to issue site video upload ids');
  }
  return secret;
}

export function issueUploadId(
  scope: UploadScope,
  secret: string | undefined = process.env.JWT_SECRET,
): string {
  const nonce = randomBytes(NONCE_BYTES).toString('hex');
  return nonce + macFor(nonce, scope, requireSecret(secret));
}

/** True only for an id this server issued to exactly this (org, unit, user). */
export function verifyUploadId(
  uploadId: string,
  scope: UploadScope,
  secret: string | undefined = process.env.JWT_SECRET,
): boolean {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) return false;
  const nonce = uploadId.slice(0, NONCE_BYTES * 2);
  const given = Buffer.from(uploadId.slice(NONCE_BYTES * 2), 'utf8');
  const expected = Buffer.from(macFor(nonce, scope, requireSecret(secret)), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
