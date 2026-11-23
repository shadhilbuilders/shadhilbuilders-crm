// The typed error catalog for the site update video routes (plan section 9).
//
// One table, so the status, the `retryable` flag and the user-facing sentence
// for a code cannot drift apart across the throw sites. Copy is the sentence a
// site engineer reads on a phone, not a diagnostic: what happened and what to
// do next. Details carry the machine-readable specifics.
import { CodedException } from '../common/errors/coded-exception';

interface ErrorSpec {
  status: number;
  retryable: boolean;
  message: string;
}

export const SITE_VIDEO_ERRORS = {
  VIDEO_CAPTURE_DISABLED: {
    status: 404,
    retryable: false,
    message: 'Video updates are not switched on for this workspace.',
  },
  VIDEO_TOO_LONG: {
    status: 400,
    retryable: false,
    message: 'That clip is longer than 45 seconds. Record a shorter one.',
  },
  VIDEO_TOO_LARGE: {
    status: 413,
    retryable: false,
    message: 'That video is too large. Record up to 45 seconds.',
  },
  VIDEO_CONTAINER_UNSUPPORTED: {
    status: 400,
    retryable: false,
    // One sentence for the whole system: an iPhone Photos recording is the
    // common cause, and the fix is to record in the app or export as MP4.
    message: 'iPhone videos are HEVC. Record it in the app, or export it as MP4 first.',
  },
  VIDEO_NOT_PRIVATE: {
    status: 400,
    retryable: false,
    message: 'That upload was not secured. Record again.',
  },
  VIDEO_POSTER_INVALID: {
    status: 400,
    retryable: false,
    message: 'We could not make a preview image. Try recording again.',
  },
  VIDEO_SIZE_MISMATCH: {
    status: 400,
    retryable: false,
    message: 'The upload did not finish. Try again.',
  },
  VIDEO_UPLOAD_NOT_FOUND: {
    status: 404,
    retryable: false,
    message: 'That upload is no longer available. Record again.',
  },
  VIDEO_UPLOAD_ID_REUSED: {
    status: 409,
    retryable: false,
    message: 'That take was already saved. Record again.',
  },
  VIDEO_UPLOAD_INVALID: {
    status: 400,
    retryable: false,
    message: 'That upload link is not valid. Record again.',
  },
  VIDEO_STORAGE_CAP_REACHED: {
    status: 409,
    retryable: false,
    message: 'Video storage is full. Ask an admin to free some space.',
  },
  VIDEO_UPLOAD_RATE_LIMITED: {
    status: 429,
    retryable: true,
    message: 'Too many uploads started. Wait a minute and try again.',
  },
  VIDEO_INLINE_UNSUPPORTED: {
    status: 400,
    retryable: false,
    message: 'This workspace uploads straight to storage. Use the signed upload.',
  },
  VIDEO_SAVE_FAILED: {
    status: 503,
    retryable: true,
    message: 'Could not save this video. Try again.',
  },
  STORAGE_UNAVAILABLE: {
    status: 503,
    retryable: true,
    message: 'Storage is not answering. Try again in a moment.',
  },
} as const satisfies Record<string, ErrorSpec>;

export type SiteVideoErrorCode = keyof typeof SITE_VIDEO_ERRORS;

/** Build the coded exception for `code`, with optional machine-readable details. */
export function siteVideoError(code: SiteVideoErrorCode, details?: unknown): CodedException {
  const spec: ErrorSpec = SITE_VIDEO_ERRORS[code];
  return new CodedException(spec.status, code, spec.message, details, spec.retryable);
}
