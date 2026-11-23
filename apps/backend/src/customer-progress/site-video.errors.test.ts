// Error catalog (site update video, step 5).
// protects= every code has the status, retryable flag and copy the plan's
// table promises, and `retryable` rides on the wire body.
// fails_when= a code's status or retryable flag drifts from the plan, or an
// existing CodedException body gains a `retryable` key it never had.
import { describe, expect, it } from 'vitest';

import { CodedException } from '../common/errors/coded-exception';
import { SITE_VIDEO_ERRORS, siteVideoError, type SiteVideoErrorCode } from './site-video.errors';

describe('site video error catalog', () => {
  // Plan section 9, restated so the table cannot drift silently.
  const PLAN: ReadonlyArray<[SiteVideoErrorCode, number, boolean]> = [
    ['VIDEO_TOO_LONG', 400, false],
    ['VIDEO_TOO_LARGE', 413, false],
    ['VIDEO_CONTAINER_UNSUPPORTED', 400, false],
    ['VIDEO_NOT_PRIVATE', 400, false],
    ['VIDEO_POSTER_INVALID', 400, false],
    ['VIDEO_SIZE_MISMATCH', 400, false],
    ['VIDEO_UPLOAD_NOT_FOUND', 404, false],
    ['VIDEO_UPLOAD_ID_REUSED', 409, false],
    ['VIDEO_SAVE_FAILED', 503, true],
    ['STORAGE_UNAVAILABLE', 503, true],
  ];

  it.each(PLAN)('%s is %i and retryable=%s', (code, status, retryable) => {
    const err = siteVideoError(code);
    expect(err.getStatus()).toBe(status);
    expect(err.getResponse()).toMatchObject({ code, retryable });
  });

  it('every message is a sentence a person can act on', () => {
    for (const spec of Object.values(SITE_VIDEO_ERRORS)) {
      expect(spec.message).toMatch(/\.$/);
      expect(spec.message.length).toBeGreaterThan(15);
    }
  });

  it('carries details through when given', () => {
    expect(
      siteVideoError('VIDEO_STORAGE_CAP_REACHED', { scope: 'PROJECT' }).getResponse(),
    ).toMatchObject({ details: { scope: 'PROJECT' } });
  });

  it('leaves an ordinary CodedException body exactly as it was', () => {
    expect(new CodedException(409, 'X', 'msg').getResponse()).toEqual({
      code: 'X',
      message: 'msg',
    });
  });
});
