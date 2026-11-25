// The browser half of the recorder: camera stream, MediaRecorder, the 45 second
// ceiling. Everything it touches is injected, so the tests drive it with fakes and
// the component never owns a track it could leak.
//
// RELEASE IS THE CONTRACT. `release()` stops every track and clears the timers; the
// component calls it on unmount, when the page is hidden, and on hardware back.
import { COUNTDOWN_MS, MAX_VIDEO_MS, MIN_VIDEO_MS } from './constants';
import {
  buildConstraints,
  classifyCameraError,
  pickRecorderMime,
  queryCameraPermission,
  readZoomCapability,
  recorderOptions,
  type ZoomCapability,
} from './recorder-support';

export interface RecorderEnv {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** The MediaRecorder constructor, or undefined where the browser has none. */
  MediaRecorder:
    | ((new (stream: MediaStream, options?: MediaRecorderOptions) => MediaRecorder) & {
        isTypeSupported(type: string): boolean;
      })
    | undefined;
  permissions: Pick<Permissions, 'query'> | undefined;
  /** The device's zoom range on this track, or null where the platform has none. */
  zoomCapability(track: MediaStreamTrack): ZoomCapability | null;
  /** Ask the camera to crop. Rejects when the device or the platform refuses. */
  applyZoom(track: MediaStreamTrack, zoom: number): Promise<void>;
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}

export interface RawTake {
  blob: Blob;
  durationMs: number;
  hasAudio: boolean;
}

export interface EngineHandlers {
  onGranted(stream: MediaStream): void;
  onDenied(permanent: boolean): void;
  onUnsupported(): void;
  /** Elapsed ms, for the on-screen timer. Never spoken. */
  onTick(elapsedMs: number): void;
  onStopped(take: RawTake): void;
  onTooShort(): void;
}

const TICK_MS = 250;

export class RecorderEngine {
  private stream: MediaStream | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private zoomCap: ZoomCapability | null = null;
  private zoomValue: number | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private hasAudio = false;
  private limitTimer: number | null = null;
  private tickTimer: number | null = null;
  private released = false;

  constructor(
    private readonly env: RecorderEnv,
    private readonly handlers: EngineHandlers,
  ) {}

  /** True once the countdown window starts, for the UI's warning state. */
  static inCountdown(elapsedMs: number): boolean {
    return elapsedMs >= MAX_VIDEO_MS - COUNTDOWN_MS;
  }

  async start(audio: boolean): Promise<void> {
    this.released = false;
    const mimeType = pickRecorderMime(this.env.MediaRecorder);
    if (mimeType === null || this.env.MediaRecorder === undefined) {
      this.handlers.onUnsupported();
      return;
    }
    let stream: MediaStream;
    try {
      stream = await this.env.getUserMedia(buildConstraints(audio));
    } catch (err) {
      const permission = await queryCameraPermission(this.env.permissions);
      const failure = classifyCameraError(err, permission);
      if (failure === 'unsupported') this.handlers.onUnsupported();
      else this.handlers.onDenied(failure === 'denied-permanent');
      return;
    }
    // Closed while the permission prompt was open: do not leave a live camera behind.
    if (this.released) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    // ZOOM IS THE CAMERA'S OWN (2026-11-26, "route A"). The device crops, so
    // MediaRecorder keeps the same track and the clip stays 720p: no canvas, no
    // second encode, no change to the poster or the upload path. Where the
    // platform exposes no range (iOS Safari today) this is null and the capture
    // bar renders no control at all rather than a dead one.
    this.videoTrack = stream.getVideoTracks()[0] ?? null;
    this.zoomCap = this.videoTrack === null ? null : this.env.zoomCapability(this.videoTrack);
    this.zoomValue = this.zoomCap === null ? null : this.zoomCap.min;
    this.hasAudio = audio && stream.getAudioTracks().length > 0;
    this.chunks = [];
    const recorder = new this.env.MediaRecorder(stream, recorderOptions(mimeType, audio));
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    recorder.onstop = () => this.finish(mimeType);
    recorder.onerror = () => this.fail();
    this.recorder = recorder;
    this.handlers.onGranted(stream);
    this.startedAt = this.env.now();
    recorder.start();
    this.limitTimer = this.env.setTimeout(() => this.stop(), MAX_VIDEO_MS);
    this.tickTimer = this.env.setInterval(
      () => this.handlers.onTick(this.env.now() - this.startedAt),
      TICK_MS,
    );
  }

  /**
   * The zoom the camera is offering right now: null before a stream starts,
   * after it is released, and on a platform with no zoom support.
   */
  zoomState(): { capability: ZoomCapability; value: number } | null {
    if (this.zoomCap === null || this.zoomValue === null) return null;
    return { capability: this.zoomCap, value: this.zoomValue };
  }

  /**
   * Ask the camera to crop. Safe DURING a recording: the recorder holds the same
   * track, so the frames come from a narrower view and the take carries on.
   * Returns false when the device refuses, and the previous value stands.
   */
  async setZoom(value: number): Promise<boolean> {
    const track = this.videoTrack;
    const cap = this.zoomCap;
    if (track === null || cap === null) return false;
    const next = Math.min(cap.max, Math.max(cap.min, value));
    try {
      await this.env.applyZoom(track, next);
      this.zoomValue = next;
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    if (this.recorder === null || this.recorder.state === 'inactive') return;
    this.clearTimers();
    this.recorder.stop();
  }

  /** Stop every track and drop the take. Safe to call any number of times. */
  release(): void {
    this.released = true;
    this.clearTimers();
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder !== null) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    this.stopTracks();
    this.chunks = [];
  }

  private finish(mimeType: string): void {
    const durationMs = this.env.now() - this.startedAt;
    const chunks = this.chunks;
    this.recorder = null;
    this.stopTracks();
    this.chunks = [];
    if (this.released) return;
    if (durationMs < MIN_VIDEO_MS || chunks.length === 0) {
      this.handlers.onTooShort();
      return;
    }
    this.handlers.onStopped({
      blob: new Blob(chunks, { type: mimeType.split(';')[0] }),
      durationMs: Math.min(durationMs, MAX_VIDEO_MS),
      hasAudio: this.hasAudio,
    });
  }

  private fail(): void {
    this.release();
    this.handlers.onDenied(false);
  }

  private stopTracks(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.videoTrack = null;
    this.zoomCap = null;
    this.zoomValue = null;
  }

  private clearTimers(): void {
    if (this.limitTimer !== null) this.env.clearTimeout(this.limitTimer);
    if (this.tickTimer !== null) this.env.clearInterval(this.tickTimer);
    this.limitTimer = null;
    this.tickTimer = null;
  }
}

export function browserRecorderEnv(): RecorderEnv {
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    MediaRecorder: typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder,
    permissions: typeof navigator.permissions === 'undefined' ? undefined : navigator.permissions,
    zoomCapability: (track) => readZoomCapability(track),
    applyZoom: async (track, zoom) => {
      // `zoom` is an Image Capture constraint and is not in the DOM lib yet, so
      // the set is cast rather than invented. It rejects on a platform that
      // does not know the constraint, which is exactly what setZoom() reports.
      await track.applyConstraints({
        advanced: [{ zoom } as unknown as MediaTrackConstraintSet],
      });
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id),
  };
}
