// Browser capability decisions for the recorder, kept out of the component so
// they are testable with fakes.
import {
  AUDIO_BITS_PER_SECOND,
  RECORDER_MIME,
  RECORDER_MIME_WITH_AUDIO,
  VIDEO_BITS_PER_SECOND,
} from './constants';

interface MimeProbe {
  isTypeSupported(type: string): boolean;
}

/**
 * The container is FORCED, not hoped for. Chrome on Android defaults to WebM,
 * which the server sniffer refuses and Meta will not accept for video, so a
 * recorder that cannot make MP4 must not open at all (the picker is offered).
 */
export function pickRecorderMime(recorder: MimeProbe | undefined): string | null {
  if (recorder === undefined) return null;
  return recorder.isTypeSupported(RECORDER_MIME) ? RECORDER_MIME : null;
}

/**
 * Whether this recorder can carry AAC with the clip. Gates the audio toggle, so
 * it is never shown on a browser where turning it on would silently produce a
 * silent clip. A missing MediaRecorder is not a place the recorder opens at all.
 */
export function supportsAudio(recorder: MimeProbe | undefined): boolean {
  return recorder !== undefined && recorder.isTypeSupported(RECORDER_MIME_WITH_AUDIO);
}

/** 720p portrait first, rear camera preferred; audio only when the toggle is on. */
export function buildConstraints(audio: boolean): MediaStreamConstraints {
  return {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 720 },
      height: { ideal: 1280 },
      frameRate: { ideal: 30 },
    },
    audio,
  };
}

export function recorderOptions(mimeType: string, audio: boolean): MediaRecorderOptions {
  return {
    mimeType,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    ...(audio ? { audioBitsPerSecond: AUDIO_BITS_PER_SECOND } : {}),
  };
}

export type CameraFailure = 'denied-temporary' | 'denied-permanent' | 'unsupported';

/**
 * Map a getUserMedia rejection to a recorder state. `permission` is the
 * Permissions API answer when the browser has one: it is the only way to tell
 * "dismissed the prompt" (ask again) from "blocked in settings" (explain where).
 */
export function classifyCameraError(
  err: unknown,
  permission: PermissionState | null,
): CameraFailure {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return permission === 'denied' ? 'denied-permanent' : 'denied-temporary';
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'TypeError':
      return 'unsupported';
    default:
      // NotReadableError (camera busy), AbortError, anything new: the user can try again.
      return 'denied-temporary';
  }
}

/** The camera permission state, or null where the browser cannot say. Never throws. */
export async function queryCameraPermission(
  permissions: Pick<Permissions, 'query'> | undefined,
): Promise<PermissionState | null> {
  if (permissions === undefined) return null;
  try {
    const status = await permissions.query({ name: 'camera' as PermissionName });
    return status.state;
  } catch {
    return null;
  }
}
