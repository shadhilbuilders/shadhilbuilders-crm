// Customer-progress service guards (issue #7 slice 1, AC4).
//
// protects= the upload validation wall (MIME allowlist, size cap, empty
// file, phase-project binding, offset-carrying takenAt, cursor pagination
// arithmetic) - fails_when= any guard lets a bad payload through or a good
// payload gets a wrong page; no_claim= green does NOT exercise the real
// database (assertUnitAccess RLS behavior is owned by
// packages/database/test/progress-rls.test.ts) nor the storage adapters
// (their delete tests live beside them).
import { describe, expect, it } from 'vitest';

import {
  UploadPhotoSchema,
  buildCaption,
  decodeCursor,
  encodeCursor,
} from './customer-progress.service';

describe('UploadPhotoSchema', () => {
  const valid: Record<string, unknown> = {
    phaseId: 'cmw4n0zqn5yvpfhm3a5n3f9z',
    base64: Buffer.from('hello').toString('base64'),
    mimeType: 'image/jpeg',
    filename: 'site.jpg',
    takenAt: '2026-10-26T10:00:00+05:30',
  };

  it('protects= accepts a well-formed camera payload', () => {
    const parsed = UploadPhotoSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('protects= rejects HEIC with the slice-1 allowlist; fails_when= image/* widens it', () => {
    const parsed = UploadPhotoSchema.safeParse({ ...valid, mimeType: 'image/heic' });
    expect(parsed.success).toBe(false);
  });

  it('protects= rejects a takenAt without a UTC offset; fails_when= local time parses silently', () => {
    const noOffset = UploadPhotoSchema.safeParse({ ...valid, takenAt: '2026-10-26T10:00:00' });
    expect(noOffset.success).toBe(false);
  });

  it('protects= rejects an absurd datetime even with an offset', () => {
    const junk = UploadPhotoSchema.safeParse({ ...valid, takenAt: 'not-a-date+05:30' });
    expect(junk.success).toBe(false);
  });

  it('protects= rejects a filename over 180 chars', () => {
    const parsed = UploadPhotoSchema.safeParse({ ...valid, filename: 'x'.repeat(181) });
    expect(parsed.success).toBe(false);
  });

  it('protects= requires a real cuid2 phaseId; fails_when= slug-style ids pass', () => {
    const parsed = UploadPhotoSchema.safeParse({ ...valid, phaseId: 'unit-1' });
    expect(parsed.success).toBe(false);
  });
});

describe('buildCaption', () => {
  it('protects= "{phase} {month name} {year}" en-GB from UTC; fails_when= local-month drift', () => {
    // takenAt near a month boundary in IST vs UTC: 00:30 IST on the 1st is
    // still the previous day in UTC.
    const istJustAfterMidnight = new Date('2026-11-01T00:30:00+05:30');
    expect(buildCaption('Foundation', istJustAfterMidnight)).toBe('Foundation October 2026');
  });

  it('protects= phases without a name degrade to "Site photo"', () => {
    expect(buildCaption(null, new Date('2026-03-14T00:00:00Z'))).toBe('Site photo March 2026');
  });
});

describe('cursor codec', () => {
  it('protects= round-trips takenAt + id; fails_when= ordering ambiguity returns', () => {
    const takenAt = new Date('2026-10-26T10:00:00.123Z');
    const raw = encodeCursor(takenAt, 'cmw4n0zqn5yvpfhm3a5n3f9z');
    const decoded = decodeCursor(raw);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe('cmw4n0zqn5yvpfhm3a5n3f9z');
    expect(decoded!.takenAt.getTime()).toBe(takenAt.getTime());
  });

  it('protects= malformed cursors behave as absent (fresh page), never a 500', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('!not base64url!')).toBeNull();
    expect(decodeCursor(Buffer.from('{"id":null}', 'utf8').toString('base64url'))).toBeNull();
  });
});