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

/** What a camera says it can do about zoom, in its own units (its min is the widest view). */
export interface ZoomCapability {
  min: number;
  max: number;
  step: number;
}

/** One zoom control the capture bar offers. */
export interface ZoomStop {
  value: number;
  label: string;
}

interface ZoomTrackLike {
  /**
   * Typed `unknown` on purpose: the DOM lib's `MediaTrackCapabilities` has no
   * `zoom` member, so a narrower return type here makes the real
   * `MediaStreamTrack` structurally incompatible with this probe.
   */
  getCapabilities(): unknown;
}

interface ZoomCapabilitiesLike {
  zoom?: { min?: unknown; max?: unknown; step?: unknown } | null;
}

interface ZoomSettingsLike {
  /** Also `unknown` on purpose, for the same reason as the capabilities probe. */
  getSettings(): unknown;
}

interface ZoomSettingsResult {
  zoom?: unknown;
}

/**
 * The camera's zoom range, or null when there is nothing honest to offer.
 *
 * Chrome on Android exposes `zoom` on MediaStreamTrack; Safari on iOS does not,
 * which is why this returns null instead of promising a control (verified: the
 * Image Capture PTZ constraints are Chrome-only). `getCapabilities` also throws
 * on some platforms, so the probe is guarded - an unguarded throw here would
 * take the whole recorder down before the first frame.
 */
export function readZoomCapability(track: ZoomTrackLike | null): ZoomCapability | null {
  if (track === null) return null;
  let caps: unknown;
  try {
    caps = track.getCapabilities();
  } catch {
    return null;
  }
  const zoom = (caps as ZoomCapabilitiesLike | null | undefined)?.zoom;
  if (zoom === undefined || zoom === null) return null;
  const { min, max, step } = zoom;
  if (typeof min !== 'number' || typeof max !== 'number') return null;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  const resolvedStep = typeof step === 'number' && Number.isFinite(step) && step > 0 ? step : 0.1;
  return { min, max, step: resolvedStep };
}

/**
 * The zoom the track is AT, in the same units as the capability, or null where
 * the platform does not report it. Chrome answers this from `getSettings()`.
 *
 * Read before trusting the minimum: a phone whose range starts at 0.5x still
 * opens its camera at 1x, so claiming the minimum lights up the wrong chip and
 * the preview disagrees with the control the whole time (found on the iPhone,
 * 2026-11-26).
 */
export function readZoomValue(track: ZoomSettingsLike | null): number | null {
  if (track === null) return null;
  let settings: unknown;
  try {
    settings = track.getSettings();
  } catch {
    return null;
  }
  const zoom = (settings as ZoomSettingsResult | null | undefined)?.zoom;
  return typeof zoom === 'number' && Number.isFinite(zoom) ? zoom : null;
}

/**
 * Snap a value onto the device's own grid, counted from its own minimum.
 */
function onStep(value: number, cap: ZoomCapability): number {
  const steps = Math.round((value - cap.min) / cap.step);
  return Math.round((cap.min + steps * cap.step) * 100) / 100;
}

/**
 * What the browser already thinks of the camera, without asking the person.
 *
 * iOS Safari answers "unknown" for camera, so unknown is treated as "ask when it
 * is needed" rather than "refuse to warm up": a sheet the person opened in order
 * to film something may show the permission dialog straight away, and that is
 * the one place where it is expected.
 */
export async function cameraPermissionState(
  permissions: Permissions | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.permissions,
): Promise<'granted' | 'denied' | 'unknown'> {
  const query = permissions?.query;
  if (typeof query !== 'function') return 'unknown';
  try {
    const status = await query.call(permissions, { name: 'camera' as PermissionName });
    if (status.state === 'granted') return 'granted';
    if (status.state === 'denied') return 'denied';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The stop the capture bar opens on: 1x, clamped into the device's range and
 * snapped to its grid. 1x is the lens a person expects, so it is selected by
 * default even when the camera can go wider; the widest stop is one tap away.
 */
export function defaultZoom(cap: ZoomCapability): number {
  const clamped = Math.min(cap.max, Math.max(cap.min, 1));
  // Round DOWN onto the grid, never up: 0.1 under 1x is still the normal lens,
  // while a step over it would open the camera tighter than the person expects.
  const steps = Math.floor((clamped - cap.min) / cap.step + 1e-9);
  return Math.round((cap.min + steps * cap.step) * 100) / 100;
}

/**
 * Up to three stops: the widest view the camera offers, then twice and three
 * times that, each clamped to the device's maximum and labelled with the value
 * actually asked for. A camera whose range ends at 1.5x gets "1x" and "1.5x",
 * not a button that promises 2x and quietly does 1.5x.
 */
export function zoomStops(cap: ZoomCapability): ZoomStop[] {
  const stops: ZoomStop[] = [];
  for (const multiplier of [1, 2, 3] as const) {
    const wanted = Math.min(cap.max, Math.max(cap.min, cap.min * multiplier));
    const value = onStep(wanted, cap);
    if (stops.some((stop) => Math.abs(stop.value - value) < 1e-9)) continue;
    stops.push({ value, label: `${value}x` });
  }
  return stops;
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
