// Copy for every failure a video save can show, keyed by the server's code
// (plan section 9). The screen never shows a code: it shows the sentence.
import { ApiError } from '@/apis/client';

const COPY: Readonly<Record<string, string>> = {
  VIDEO_TOO_LONG: 'That clip is longer than 45 seconds. Record a shorter one.',
  VIDEO_TOO_LARGE: 'That video is too large. Record up to 45 seconds.',
  // Named, not generic: an iPhone Photos recording is always .mov/HEVC and is
  // refused by design (Meta will not accept it, and Chrome cannot play it), so
  // someone who just picked one needs to know that recording in the app is the
  // way forward, not that they somehow picked a "bad file".
  VIDEO_CONTAINER_UNSUPPORTED:
    'iPhone videos are HEVC. Record it in the app, or export it as MP4 first.',
  VIDEO_NOT_PRIVATE: 'That upload was not secured. Record again.',
  VIDEO_POSTER_INVALID: 'We could not make a preview image. Try recording again.',
  VIDEO_SIZE_MISMATCH: 'The upload did not finish. Try again.',
  VIDEO_UPLOAD_NOT_FOUND: 'That upload is no longer available. Record again.',
  VIDEO_UPLOAD_ID_REUSED: 'That take was already saved. Record again.',
  VIDEO_SAVE_FAILED: 'Could not save this video. Try again.',
  STORAGE_UNAVAILABLE: 'Storage is not answering. Try again in a moment.',
  VIDEO_STORAGE_CAP_REACHED: 'This project has no video storage left. Ask an admin.',
  VIDEO_UPLOAD_RATE_LIMITED: 'Too many uploads just now. Try again in a few minutes.',
  VIDEO_CAPTURE_DISABLED: 'Video is not turned on yet.',
};

/**
 * One sentence for a picked file that cannot be used. The iPhone case is named
 * because it is by far the most common one and the fix is not "try another
 * file": a Photos recording is .mov/HEVC, which the pipeline refuses on purpose.
 */
export const CONTAINER_UNSUPPORTED_ERROR = COPY['VIDEO_CONTAINER_UNSUPPORTED']!;

export const GENERIC_VIDEO_ERROR = 'Could not save this video. Try again.';
export const OFFLINE_VIDEO_ERROR = 'You are offline. Connect and try again.';

/** A thrown value that means the network itself failed (fetch, XHR, abort excluded). */
export class UploadNetworkError extends Error {
  constructor(message = 'Network error during upload') {
    super(message);
    this.name = 'UploadNetworkError';
  }
}

/** The user cancelled: not a failure, no toast. */
export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadCancelledError';
  }
}

export function videoErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code !== null) return COPY[err.code] ?? GENERIC_VIDEO_ERROR;
  if (err instanceof UploadNetworkError) return OFFLINE_VIDEO_ERROR;
  return GENERIC_VIDEO_ERROR;
}

/**
 * Should the screen offer "Retry"? Only the server's typed flag counts for an
 * API error, never a string match. A dropped connection is always worth a retry.
 */
export function isRetryableVideoError(err: unknown): boolean {
  if (err instanceof UploadCancelledError) return false;
  if (err instanceof UploadNetworkError) return true;
  return err instanceof ApiError && err.retryable === true;
}
