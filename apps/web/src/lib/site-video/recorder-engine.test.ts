// RecorderEngine.
// protects= the camera is released on every exit path, MP4 is the only container
// asked for, the 45 s ceiling stops a take, a too-short tap is discarded, a prompt
// answered after Close leaves no live track, and audio is requested only when on.
// fails_when= a track outlives release(), a take keeps recording past 45 s, a
// sub-second clip is saved, or getUserMedia is called on a WebM-only browser.
import { describe, expect, it, vi } from 'vitest';

import { RECORDER_MIME } from './constants';
import { RecorderEngine, type EngineHandlers, type RecorderEnv } from './recorder-engine';

class FakeRecorder {
  static types = new Set([RECORDER_MIME]);
  static isTypeSupported = (t: string) => FakeRecorder.types.has(t);
  static last: FakeRecorder | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public stream: MediaStream,
    public options?: MediaRecorderOptions,
  ) {
    FakeRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array(50)]) });
    this.onstop?.();
  }
}

function fakeStream(audio = true) {
  const tracks = [
    { stop: vi.fn(), kind: 'video' },
    ...(audio ? [{ stop: vi.fn(), kind: 'audio' }] : []),
  ];
  return {
    tracks,
    stream: {
      getTracks: () => tracks,
      getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
      getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    } as unknown as MediaStream,
  };
}

function setup(
  opts: {
    reject?: Error;
    permission?: PermissionState;
    webmOnly?: boolean;
    audioTrack?: boolean;
    /** The range the fake camera reports; null means "no zoom on this platform". */
    zoom?: { min: number; max: number; step: number } | null;
    /**
     * The zoom the fake camera opens at, as `getSettings()` would report it.
     * Defaults to null, i.e. a platform that hides the value.
     */
    startsAt?: number;
    /** True when the device refuses an applyConstraints. */
    refusesZoom?: boolean;
    /** True when the device accepts the constraint and does not move. */
    ignoresZoom?: boolean;
  } = {},
) {
  FakeRecorder.types = new Set(opts.webmOnly ? ['video/webm'] : [RECORDER_MIME]);
  const clock = { t: 0 };
  const timers: { fn: () => void; ms: number; id: number; interval: boolean }[] = [];
  let nextId = 1;
  const fs = fakeStream(opts.audioTrack ?? true);
  let resolveMedia: ((s: MediaStream) => void) | null = null;
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((resolve, reject) => {
        if (opts.reject) reject(opts.reject);
        else resolveMedia = resolve;
      }),
  );
  // The lens state the fake device reports back, updated by applyZoom so a real
  // read-back behaves like a real camera: apply 0.5, read 0.5.
  const lens: { value: number | null } = { value: opts.startsAt ?? null };
  const applyZoom = vi.fn(async (_track: MediaStreamTrack, zoom: number) => {
    if (opts.refusesZoom) throw new Error('ConstraintNotSatisfiedError');
    // A camera that accepts the constraint but does not move, which is how the
    // iPhone behaved: asked for 0.5x, stayed at 1x.
    if (opts.ignoresZoom) return;
    lens.value = zoom;
  });
  const env: RecorderEnv = {
    getUserMedia,
    MediaRecorder: FakeRecorder as never,
    permissions: opts.permission
      ? { query: vi.fn(async () => ({ state: opts.permission }) as PermissionStatus) }
      : undefined,
    zoomCapability: () => opts.zoom ?? null,
    zoomValue: () => lens.value,
    applyZoom,
    now: () => clock.t,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, id: nextId, interval: false });
      return nextId++;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    setInterval: (fn, ms) => {
      timers.push({ fn, ms, id: nextId, interval: true });
      return nextId++;
    },
    clearInterval: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const handlers = {
    onGranted: vi.fn(),
    onDenied: vi.fn(),
    onUnsupported: vi.fn(),
    onTick: vi.fn(),
    onStopped: vi.fn(),
    onTooShort: vi.fn(),
  } satisfies EngineHandlers;
  const engine = new RecorderEngine(env, handlers);
  const grant = () => resolveMedia?.(fs.stream);
  return {
    engine,
    handlers,
    getUserMedia,
    applyZoom,
    lens,
    clock,
    timers,
    tracks: fs.tracks,
    grant,
  };
}

async function started(s: ReturnType<typeof setup>, audio = false) {
  const p = s.engine.start(audio);
  await Promise.resolve();
  s.grant();
  await p;
}

describe('prepare', () => {
  it('opens the camera once, so the next tap only starts the recorder', async () => {
    // Measured on an iPhone 2026-11-26: tapping Record cost 3.3 seconds, every
    // take, because it opened the camera and negotiated 720x1280 first. Warming
    // the sheet moves that off the tap.
    const s = setup();
    const prepared = s.engine.prepare(false);
    await Promise.resolve();
    s.grant();
    await expect(prepared).resolves.toBe(true);

    expect(s.getUserMedia).toHaveBeenCalledTimes(1);
    // Warming is silent: nothing is recording yet, so the sheet is told nothing.
    expect(s.handlers.onGranted).not.toHaveBeenCalled();

    await started(s);
    expect(s.getUserMedia).toHaveBeenCalledTimes(1);
    // A warm take still reports the camera, or the sheet never leaves `requesting`.
    expect(s.handlers.onGranted).toHaveBeenCalledTimes(1);
  });

  it('opens a new stream when the audio choice changes, and stops the old one', async () => {
    const s = setup();
    const first = s.engine.prepare(false);
    await Promise.resolve();
    s.grant();
    await first;

    const second = s.engine.prepare(true);
    await Promise.resolve();
    s.grant();
    await second;

    expect(s.getUserMedia).toHaveBeenCalledTimes(2);
    // The old camera is stopped before the new one is opened, so two live
    // cameras never sit behind the same sheet.
    expect(s.tracks[0]?.stop).toHaveBeenCalled();
  });
});

describe('start', () => {
  it('records MP4 and reports granted', async () => {
    const s = setup();
    await started(s);
    expect(s.handlers.onGranted).toHaveBeenCalledOnce();
    expect(FakeRecorder.last?.options?.mimeType).toBe(RECORDER_MIME);
    expect(FakeRecorder.last?.state).toBe('recording');
  });

  it('never asks for the camera in a WebM-only browser', async () => {
    const s = setup({ webmOnly: true });
    await s.engine.start(false);
    expect(s.handlers.onUnsupported).toHaveBeenCalled();
    expect(s.getUserMedia).not.toHaveBeenCalled();
  });

  it('requests audio only when the toggle is on', async () => {
    const off = setup();
    await started(off, false);
    expect((off.getUserMedia.mock.calls[0] as unknown[])[0]).toMatchObject({ audio: false });
    const on = setup();
    await started(on, true);
    expect((on.getUserMedia.mock.calls[0] as unknown[])[0]).toMatchObject({ audio: true });
  });

  it.each([
    ['NotAllowedError', 'denied', true],
    ['NotAllowedError', 'prompt', false],
  ])('maps %s with permission %s to permanent=%s', async (name, permission, permanent) => {
    const s = setup({
      reject: Object.assign(new Error(name), { name }),
      permission: permission as PermissionState,
    });
    await s.engine.start(false);
    expect(s.handlers.onDenied).toHaveBeenCalledWith(permanent);
  });

  it('maps a missing camera to unsupported', async () => {
    const s = setup({ reject: Object.assign(new Error('x'), { name: 'NotFoundError' }) });
    await s.engine.start(false);
    expect(s.handlers.onUnsupported).toHaveBeenCalled();
  });

  it('leaves no live track when released while the prompt was open', async () => {
    const s = setup();
    const p = s.engine.start(false);
    await Promise.resolve();
    s.engine.release();
    s.grant();
    await p;
    expect(s.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(s.handlers.onGranted).not.toHaveBeenCalled();
  });
});

describe('stopping', () => {
  it('delivers an MP4 blob with the measured duration and stops the camera', async () => {
    const s = setup();
    await started(s, true);
    s.clock.t = 12_000;
    s.engine.stop();
    const take = s.handlers.onStopped.mock.calls[0]![0];
    expect(take.durationMs).toBe(12_000);
    expect(take.hasAudio).toBe(true);
    expect(take.blob.type).toBe('video/mp4');
    expect(s.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
  });

  it('reports no audio when the browser gave no audio track', async () => {
    const s = setup({ audioTrack: false });
    await started(s, true);
    s.clock.t = 5_000;
    s.engine.stop();
    expect(s.handlers.onStopped.mock.calls[0]![0].hasAudio).toBe(false);
  });

  it('auto-stops at 45 seconds', async () => {
    const s = setup();
    await started(s);
    const limit = s.timers.find((t) => !t.interval)!;
    expect(limit.ms).toBe(45_000);
    s.clock.t = 45_000;
    limit.fn();
    expect(s.handlers.onStopped.mock.calls[0]![0].durationMs).toBe(45_000);
  });

  it('discards a tap shorter than one second', async () => {
    const s = setup();
    await started(s);
    s.clock.t = 400;
    s.engine.stop();
    expect(s.handlers.onTooShort).toHaveBeenCalled();
    expect(s.handlers.onStopped).not.toHaveBeenCalled();
  });

  it('ticks the timer without announcing anything itself', async () => {
    const s = setup();
    await started(s);
    s.clock.t = 3_000;
    s.timers.find((t) => t.interval)!.fn();
    expect(s.handlers.onTick).toHaveBeenCalledWith(3_000);
  });
});

describe('release', () => {
  it('stops tracks, clears timers, and delivers nothing afterwards', async () => {
    const s = setup();
    await started(s);
    s.engine.release();
    expect(s.tracks.every((t) => t.stop.mock.calls.length >= 1)).toBe(true);
    expect(s.timers).toHaveLength(0);
    expect(s.handlers.onStopped).not.toHaveBeenCalled();
    expect(() => s.engine.release()).not.toThrow();
  });
});

describe('inCountdown', () => {
  it('turns on for the last ten seconds only', () => {
    expect(RecorderEngine.inCountdown(34_999)).toBe(false);
    expect(RecorderEngine.inCountdown(35_000)).toBe(true);
  });
});

describe('zoom (route A: the camera crops itself)', () => {
  it('reports no zoom before a stream exists and after release', async () => {
    const s = setup({ zoom: { min: 1, max: 4, step: 0.1 } });
    expect(s.engine.zoomState()).toBeNull();
    await started(s);
    expect(s.engine.zoomState()).toEqual({ capability: { min: 1, max: 4, step: 0.1 }, value: 1 });
    s.engine.release();
    expect(s.engine.zoomState()).toBeNull();
  });

  it('opens on 1x even though the lens can go wider', async () => {
    // The iPhone: a range that starts at 0.5x, opening at 1x. The old code
    // claimed the minimum, so the 0.5x chip looked selected while the picture
    // was 1x. Now 1x is asked for and 1x is what the bar shows.
    const s = setup({ zoom: { min: 0.5, max: 3, step: 0.1 }, startsAt: 0.5 });
    await started(s);

    expect(s.applyZoom).toHaveBeenCalledWith(s.tracks[0], 1);
    expect(s.lens.value).toBe(1);
    expect(s.engine.zoomState()?.value).toBe(1);
  });

  it('shows the lens, not the request, when the camera ignores 1x', async () => {
    const s = setup({ zoom: { min: 0.5, max: 3, step: 0.1 }, startsAt: 0.5, ignoresZoom: true });
    await started(s);

    // Asked for 1x, stayed at 0.5x: the chip must say 0.5x rather than lie.
    expect(s.applyZoom).toHaveBeenCalledWith(s.tracks[0], 1);
    expect(s.engine.zoomState()?.value).toBe(0.5);
  });

  it('switches to the wider stop when the person asks for it', async () => {
    const s = setup({ zoom: { min: 0.5, max: 3, step: 0.1 }, startsAt: 1 });
    await started(s);

    await expect(s.engine.setZoom(0.5)).resolves.toBe(true);
    expect(s.lens.value).toBe(0.5);
    expect(s.engine.zoomState()?.value).toBe(0.5);
  });

  it('offers nothing on a platform that reports no range', async () => {
    const s = setup({ zoom: null });
    await started(s);
    expect(s.engine.zoomState()).toBeNull();
    // A stop is a no-op rather than a throw: the UI has no control to press.
    await expect(s.engine.setZoom(2)).resolves.toBe(false);
    expect(s.applyZoom).not.toHaveBeenCalled();
  });

  it('zooms the SAME track the recorder holds, without restarting it', async () => {
    const s = setup({ zoom: { min: 1, max: 4, step: 0.1 } });
    await started(s);

    await expect(s.engine.setZoom(2)).resolves.toBe(true);

    // One camera request for the whole take, and the constraint lands on the
    // video track MediaRecorder is already recording.
    expect(s.getUserMedia).toHaveBeenCalledTimes(1);
    expect(s.applyZoom).toHaveBeenCalledWith(s.tracks[0], 2);
    expect(s.engine.zoomState()?.value).toBe(2);
    // Still recording: the take did not end when the view changed.
    expect(s.handlers.onStopped).not.toHaveBeenCalled();
  });

  it('clamps to the device range instead of asking for the impossible', async () => {
    const s = setup({ zoom: { min: 1, max: 4, step: 0.1 } });
    await started(s);
    await s.engine.setZoom(9);
    expect(s.applyZoom).toHaveBeenLastCalledWith(s.tracks[0], 4);
    expect(s.engine.zoomState()?.value).toBe(4);
  });

  it('keeps the previous value when the camera refuses', async () => {
    const s = setup({ zoom: { min: 1, max: 4, step: 0.1 }, refusesZoom: true });
    await started(s);

    await expect(s.engine.setZoom(3)).resolves.toBe(false);
    // The chip must not move to a stop the camera never took.
    expect(s.engine.zoomState()?.value).toBe(1);
  });
});
