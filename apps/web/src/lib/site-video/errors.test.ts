// videoErrorMessage / isRetryableVideoError.
// protects= every coded failure shows its sentence (never the code), unknown
// codes degrade to one honest sentence, and Retry follows the server's typed flag.
// fails_when= a code leaks to the screen, a non-retryable code offers Retry, or
// retryability is guessed from status or text.
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/apis/client';

import {
  GENERIC_VIDEO_ERROR,
  UploadCancelledError,
  UploadNetworkError,
  isRetryableVideoError,
  videoErrorMessage,
} from './errors';

const err = (code: string | null, retryable: boolean | null = null, status = 400) =>
  new ApiError('server words', status, code, undefined, retryable);

describe('videoErrorMessage', () => {
  it.each([
    ['VIDEO_TOO_LONG', 'That clip is longer than 45 seconds. Record a shorter one.'],
    ['VIDEO_TOO_LARGE', 'That video is too large. Record up to 45 seconds.'],
    [
      'VIDEO_CONTAINER_UNSUPPORTED',
      'iPhone videos are HEVC. Record it in the app, or export it as MP4 first.',
    ],
    ['VIDEO_NOT_PRIVATE', 'That upload was not secured. Record again.'],
    ['VIDEO_POSTER_INVALID', 'We could not make a preview image. Try recording again.'],
    ['VIDEO_SIZE_MISMATCH', 'The upload did not finish. Try again.'],
    ['VIDEO_UPLOAD_NOT_FOUND', 'That upload is no longer available. Record again.'],
    ['VIDEO_UPLOAD_ID_REUSED', 'That take was already saved. Record again.'],
    ['VIDEO_SAVE_FAILED', 'Could not save this video. Try again.'],
    ['STORAGE_UNAVAILABLE', 'Storage is not answering. Try again in a moment.'],
  ])('%s shows its sentence, not the code or the server text', (code, sentence) => {
    expect(videoErrorMessage(err(code))).toBe(sentence);
  });

  it('degrades unknown or missing codes to one generic sentence', () => {
    expect(videoErrorMessage(err('SOMETHING_NEW'))).toBe(GENERIC_VIDEO_ERROR);
    expect(videoErrorMessage(err(null))).toBe(GENERIC_VIDEO_ERROR);
    expect(videoErrorMessage(new Error('boom'))).toBe(GENERIC_VIDEO_ERROR);
  });

  it('says offline for a dropped connection', () => {
    expect(videoErrorMessage(new UploadNetworkError())).toMatch(/offline/i);
  });
});

describe('isRetryableVideoError', () => {
  it('follows the typed flag only', () => {
    expect(isRetryableVideoError(err('VIDEO_SAVE_FAILED', true, 503))).toBe(true);
    expect(isRetryableVideoError(err('VIDEO_TOO_LONG', false))).toBe(false);
    // A 503 with no flag is NOT assumed retryable.
    expect(isRetryableVideoError(err(null, null, 503))).toBe(false);
  });

  it('retries a network drop but never a cancel', () => {
    expect(isRetryableVideoError(new UploadNetworkError())).toBe(true);
    expect(isRetryableVideoError(new UploadCancelledError())).toBe(false);
  });
});
