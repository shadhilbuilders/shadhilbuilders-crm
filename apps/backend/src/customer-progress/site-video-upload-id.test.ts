// Server-issued upload ids (site update video, step 5).
// protects= an upload folder can only be used by the (org, unit, user) it was
// issued to, with no server-side state.
// fails_when= another user, unit or org can verify an id, a tampered or
// malformed id verifies, or two ids collide.
import { describe, expect, it } from 'vitest';

import { UPLOAD_ID_PATTERN, issueUploadId, verifyUploadId } from './site-video-upload-id';

const SECRET = 'test-secret-with-enough-length-0123456789';
const scope = { organizationId: 'org-1', unitId: 'unit-1', userId: 'user-1' };

describe('site video upload ids', () => {
  it('issues a 64-hex id that verifies for the same scope', () => {
    const id = issueUploadId(scope, SECRET);
    expect(id).toMatch(UPLOAD_ID_PATTERN);
    expect(verifyUploadId(id, scope, SECRET)).toBe(true);
  });

  it('issues a fresh id every time', () => {
    expect(issueUploadId(scope, SECRET)).not.toBe(issueUploadId(scope, SECRET));
  });

  it.each([
    ['another user', { ...scope, userId: 'user-2' }],
    ['another unit', { ...scope, unitId: 'unit-2' }],
    ['another organisation', { ...scope, organizationId: 'org-2' }],
  ])('does not verify for %s', (_name, other) => {
    expect(verifyUploadId(issueUploadId(scope, SECRET), other, SECRET)).toBe(false);
  });

  it('does not verify under a different secret', () => {
    expect(verifyUploadId(issueUploadId(scope, SECRET), scope, `${SECRET}x`)).toBe(false);
  });

  it('rejects a tampered id', () => {
    const id = issueUploadId(scope, SECRET);
    const flipped = id.slice(0, -1) + (id.endsWith('0') ? '1' : '0');
    expect(verifyUploadId(flipped, scope, SECRET)).toBe(false);
    const nonceSwapped = (id[0] === 'a' ? 'b' : 'a') + id.slice(1);
    expect(verifyUploadId(nonceSwapped, scope, SECRET)).toBe(false);
  });

  it.each(['', 'abc', 'g'.repeat(64), '../'.padEnd(64, 'a'), 'A'.repeat(64), 'a'.repeat(65)])(
    'rejects the malformed id %j',
    (bad) => {
      expect(verifyUploadId(bad, scope, SECRET)).toBe(false);
    },
  );

  it('refuses to issue or verify without a real secret', () => {
    expect(() => issueUploadId(scope, '')).toThrow(/JWT_SECRET/);
    expect(() => issueUploadId(scope, 'short')).toThrow(/JWT_SECRET/);
    expect(() => verifyUploadId('a'.repeat(64), scope, '')).toThrow(/JWT_SECRET/);
  });
});
