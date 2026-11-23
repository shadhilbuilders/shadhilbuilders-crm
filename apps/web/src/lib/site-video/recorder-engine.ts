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
  recorderOptions,
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
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id),
  };
}
