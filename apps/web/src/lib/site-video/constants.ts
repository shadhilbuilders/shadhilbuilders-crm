// Numbers the recorder, the uploader and the tests share. One definition each,
// mirrored from the backend (apps/backend/src/storage/storage.limits.ts and
// customer-progress/site-video.schemas.ts); the backend is the authority and
// refuses anything outside them, these only keep the client honest earlier.

export const MAX_VIDEO_MS = 45_000;
export const MIN_VIDEO_MS = 1_000;
/** The last stretch in which the countdown shows. */
export const COUNTDOWN_MS = 10_000;
export const MAX_VIDEO_BYTES = 14_680_064;
export const POSTER_MAX_BYTES = 2 * 1024 * 1024;
export const VIDEO_BITS_PER_SECOND = 2_500_000;
export const AUDIO_BITS_PER_SECOND = 64_000;
/** Stop control and every capture-bar target: one number, used everywhere. */
export const STOP_BUTTON_PX = 72;
export const MIN_TARGET_PX = 44;
/** Picker caps per kind (plan section 6). */
export const MAX_PICKED_PHOTOS = 8;
export const MAX_PICKED_VIDEOS = 1;
/** The only container the recorder produces. WebM is never produced. */
export const RECORDER_MIME = 'video/mp4;codecs=avc1';
/**
 * What an audio take needs: the video codec AND AAC in one recorder. A browser
 * can support `avc1` alone (video-only MP4) and still refuse this, in which case
 * its MediaRecorder silently drops the audio track - so the toggle is only
 * offered where this is supported. Verified in headless Chromium 2026-11-23:
 * `avc1` true, `avc1,mp4a.40.2` false.
 */
export const RECORDER_MIME_WITH_AUDIO = 'video/mp4;codecs=avc1,mp4a.40.2';
