// SiteRecorder: the screen wired to its engine, reducer and uploader.
//
// protects= the sheet opens recording, Stop leads to a review with Retake and Use
// clip, Use clip saves THIS take with the picked stage and caption and closes on
// success, a retryable failure offers Retry that re-sends the same clip while a
// non-retryable one does not, denial offers the picker, and closing releases the
// camera.
// fails_when= Use clip saves a different take, Retry shows for a dead take, the
// camera is left live after close, or an error code reaches the screen.
// no_claim= real MediaRecorder/camera behaviour (the Playwright run on devices),
// and byte-level upload (upload.test.ts).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ApiError } from '@/apis/client';
import type { Clip } from '@/lib/site-video/recorder-machine';

const mocks = vi.hoisted(() => ({
  handlers: null as null | Record<string, (...a: never[]) => void>,
  /** What the engine reports for zoom; each test sets it. */
  zoom: null as null | { capability: { min: number; max: number; step: number }; value: number },
  setZoom: vi.fn(async (): Promise<boolean> => true),
  release: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  prepare: vi.fn(async (): Promise<boolean> => true),
  save: vi.fn(),
  cancel: vi.fn(async () => undefined),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/site-video/recorder-engine', () => ({
  RecorderEngine: class {
    static inCountdown = (ms: number) => ms >= 35_000;
    constructor(_env: unknown, handlers: Record<string, (...a: never[]) => void>) {
      mocks.handlers = handlers;
    }
    start = mocks.start;
    prepare = mocks.prepare;
    currentStream = () => null;
    stop = mocks.stop;
    release = mocks.release;
    zoomState = () => mocks.zoom;
    setZoom = mocks.setZoom;
  },
  browserRecorderEnv: () => ({}),
}));
vi.mock('@/lib/site-video/finalize-clip', () => ({
  browserFinalizeDeps: () => ({}),
  finalizeClip: async (take: { blob: Blob; durationMs: number; hasAudio: boolean }) => ({
    ...take,
    poster: new Blob(['p'], { type: 'image/jpeg' }),
  }),
}));
vi.mock('@/hooks/queries/site-video', () => ({
  useVideoSave: () => ({ save: mocks.save, cancel: mocks.cancel }),
}));
vi.mock('@paalstack/react-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@paalstack/react-ui')>()),
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { SiteRecorder } from './SiteRecorder';

const TAKE = { blob: new Blob(['v'], { type: 'video/mp4' }), durationMs: 12_000, hasAudio: false };

let container: HTMLDivElement;
let root: Root | null;
const onOpenChange = vi.fn();
const onSaved = vi.fn();
const onChooseFile = vi.fn();

const q = (qa: string) => document.body.querySelector(`[data-qa="${qa}"]`) as HTMLElement | null;
const click = async (qa: string) => {
  await act(async () => {
    q(qa)?.click();
  });
};
const fire = async (name: string, ...args: unknown[]) => {
  await act(async () => {
    (mocks.handlers![name] as (...a: unknown[]) => void)(...args);
    await Promise.resolve();
  });
};

async function mount(initialClip: Clip | null = null) {
  await act(async () => {
    root?.render(
      <SiteRecorder
        open
        onOpenChange={onOpenChange}
        unitId="u1"
        unitNumber="B-101"
        phaseId="ph1"
        defaultStage={null}
        onSaved={onSaved}
        onChooseFile={onChooseFile}
        initialClip={initialClip}
      />,
    );
  });
}

async function toPreview() {
  await click('recorder-start');
  await fire('onGranted', { getTracks: () => [] });
  await click('recorder-stop');
  await fire('onStopped', TAKE);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers = null;
  mocks.zoom = null;
  mocks.start.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  window.history.replaceState({}, '', '/');
  // The ?timings=1 flag is remembered in sessionStorage, so one test that turned
  // it on would light the bar up in the next.
  sessionStorage.clear();
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  document.body.innerHTML = '';
});

describe('SiteRecorder', () => {
  it('measures the gate numbers on screen only when ?timings=1 is in the URL', async () => {
    // The device gate needs four numbers per handset. A stopwatch is a guess, so
    // the recorder takes them itself: tap to running, tap to saved, clip opened,
    // and what the browser produced. Real customers never see it.
    mocks.save.mockResolvedValue({ id: 'vid-1' });
    window.history.replaceState({}, '', '/?timings=1');
    await mount();

    await click('recorder-start');
    await fire('onGranted', { getTracks: () => [] });
    expect(q('recorder-timings')?.textContent).toContain('record start');

    await click('recorder-stop');
    await fire('onStopped', TAKE);
    const preview = q('video-preview');
    await act(async () => {
      preview?.dispatchEvent(new Event('loadeddata'));
    });
    expect(q('recorder-timings')?.textContent).toContain('open');

    await click('video-save');
    const readout = q('recorder-timings')?.textContent ?? '';
    expect(readout).toMatch(/save \d/);
    expect(readout).toContain('clip 12.0 s');

    // The numbers ride with the take too, so nobody has to read them off a phone
    // screen. They were silently left out once, because the save callback closed
    // over an older render in which the flag was still off (2026-11-26).
    const sent = mocks.save.mock.calls.at(-1)?.[0] as {
      timings?: { recordStartMs: number | null; clipBytes: number | null };
    };
    expect(sent.timings).toBeDefined();
    expect(typeof sent.timings?.recordStartMs).toBe('number');
    expect(sent.timings?.clipBytes).toBe(TAKE.blob.size);
  });

  it('warms the camera when the sheet opens, so Record is a tap and not a wait', async () => {
    // 3.3 seconds of camera negotiation sat inside the Record tap on an iPhone
    // (2026-11-26). The sheet opens on a live preview now, and only the recorder
    // is left for the tap.
    await mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.prepare).toHaveBeenCalled();
    // Warming does not record: the stop control is still absent.
    expect(q('recorder-stop')).toBeNull();
  });

  it('shows no readout on an ordinary URL', async () => {
    window.history.replaceState({}, '', '/');
    await mount();
    await click('recorder-start');
    await fire('onGranted', { getTracks: () => [] });
    expect(q('recorder-timings')).toBeNull();
    await click('recorder-stop');
    await fire('onStopped', TAKE);
    await click('video-save');
    // A customer's upload stays exactly what it was: no timings field at all.
    const sent = mocks.save.mock.calls.at(-1)?.[0] as { timings?: unknown };
    expect(sent.timings).toBeUndefined();
  });

  it('opens ready, not recording, so audio is chosen before the first frame', async () => {
    // A MediaRecorder's tracks are fixed when it starts: an audio switch on the
    // recording screen could only change the NEXT take while looking like it
    // changed this one. So the sheet opens on Record + the Audio toggle.
    await mount();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(q('recorder-start')).not.toBeNull();
    expect(q('recorder-stop')).toBeNull();
  });

  it('offers no audio switch where the recorder cannot mux AAC, and asks for no audio', async () => {
    // jsdom has no MediaRecorder, so this is the video-only browser case. A switch
    // here would produce a silent clip the engineer believes has sound.
    await mount();
    expect(q('recorder-audio')).toBeNull();
    expect(q('recorder-audio-unavailable')).not.toBeNull();
    await click('recorder-start');
    expect(mocks.start).toHaveBeenCalledWith(false);
  });

  it('offers the camera zoom while recording, and applies a stop mid-clip', async () => {
    mocks.zoom = { capability: { min: 1, max: 4, step: 0.1 }, value: 1 };
    await mount();
    // No stream yet, so no range: the control must not appear before the camera does.
    expect(q('recorder-zoom')).toBeNull();

    await click('recorder-start');
    await fire('onGranted', { getTracks: () => [] });

    expect(q('recorder-zoom')).not.toBeNull();
    expect(q('recorder-zoom-1x')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('recorder-zoom-2x')?.getAttribute('aria-pressed')).toBe('false');

    // The engine reports the new value once the camera accepts, and the chip follows it.
    mocks.zoom = { ...mocks.zoom!, value: 2 };
    await click('recorder-zoom-2x');
    expect(mocks.setZoom).toHaveBeenCalledWith(2);
    expect(q('recorder-zoom-2x')?.getAttribute('aria-pressed')).toBe('true');
    // The take carries on: a zoom is not a stop.
    expect(q('video-review')).toBeNull();
    expect(q('recorder-stop')).not.toBeNull();
  });

  it('shows no zoom control on a camera that reports no range (iPhone today)', async () => {
    mocks.zoom = null;
    await mount();
    await click('recorder-start');
    await fire('onGranted', { getTracks: () => [] });

    // An honest absence, not a disabled button: there is nothing to offer.
    expect(q('recorder-zoom')).toBeNull();
  });

  it('leaves the chip where it was when the camera refuses the stop', async () => {
    mocks.zoom = { capability: { min: 1, max: 4, step: 0.1 }, value: 1 };
    mocks.setZoom.mockResolvedValueOnce(false);
    await mount();
    await click('recorder-start');
    await fire('onGranted', { getTracks: () => [] });

    await click('recorder-zoom-3x');

    expect(mocks.setZoom).toHaveBeenCalledWith(3);
    expect(q('recorder-zoom-1x')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('recorder-zoom-3x')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('Record starts the camera with audio off by default, then shows a stop control', async () => {
    await mount();
    await click('recorder-start');
    expect(mocks.start).toHaveBeenCalledWith(false);
    await fire('onGranted', { getTracks: () => [] });
    expect(q('recorder-stop')).not.toBeNull();
    expect(q('recorder-timer')).not.toBeNull();
    expect(q('recorder-live')?.textContent).toBe('Recording');
  });

  it('Stop leads to a review with Retake and Use clip', async () => {
    await mount();
    await toPreview();
    expect(mocks.stop).toHaveBeenCalled();
    expect(q('video-preview')).not.toBeNull();
    expect(q('video-retake')).not.toBeNull();
    expect(q('video-save')).not.toBeNull();
  });

  it('Use clip saves THIS clip for this phase, then closes and reports the row', async () => {
    mocks.save.mockResolvedValue({ id: 'vid-1' });
    await mount();
    await toPreview();
    await click('video-save');
    const input = mocks.save.mock.calls[0]![0] as { clip: Clip; phaseId: string };
    expect(input.clip.blob).toBe(TAKE.blob);
    expect(input.clip.poster.type).toBe('image/jpeg');
    expect(input.phaseId).toBe('ph1');
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Update saved');
    expect(onSaved).toHaveBeenCalledWith({ id: 'vid-1' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a retryable failure shows the sentence (no code) and Retry re-sends the same clip', async () => {
    mocks.save
      .mockRejectedValueOnce(new ApiError('x', 503, 'VIDEO_SAVE_FAILED', undefined, true))
      .mockResolvedValueOnce({ id: 'vid-1' });
    await mount();
    await toPreview();
    await click('video-save');
    expect(q('video-error')?.textContent).toBe('Could not save this video. Try again.');
    expect(q('video-error')?.textContent).not.toMatch(/VIDEO_/);
    await click('video-retry');
    expect(mocks.save).toHaveBeenCalledTimes(2);
    const first = mocks.save.mock.calls[0]![0] as { clip: Clip };
    const second = mocks.save.mock.calls[1]![0] as { clip: Clip };
    expect(second.clip.blob).toBe(first.clip.blob);
    expect(onSaved).toHaveBeenCalled();
  });

  it('a non-retryable failure offers Retake but no Retry', async () => {
    mocks.save.mockRejectedValueOnce(new ApiError('x', 400, 'VIDEO_TOO_LONG', undefined, false));
    await mount();
    await toPreview();
    await click('video-save');
    expect(q('video-error')?.textContent).toMatch(/45 seconds/);
    expect(q('video-retry')).toBeNull();
    expect(q('video-retake')).not.toBeNull();
  });

  it('a clip picked from the gallery opens on the review and never starts the camera', async () => {
    const picked: Clip = { ...TAKE, poster: new Blob(['p'], { type: 'image/jpeg' }) };
    await mount(picked);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(q('video-preview')).not.toBeNull();
    mocks.save.mockResolvedValue({ id: 'vid-9' });
    await click('video-save');
    expect((mocks.save.mock.calls[0]![0] as { clip: Clip }).clip.blob).toBe(TAKE.blob);
  });

  it('a blocked camera offers the picker instead of a dead end', async () => {
    await mount();
    await click('recorder-start');
    await fire('onDenied', true);
    expect(q('recorder-permission')?.textContent).toMatch(/blocked/i);
    expect(q('recorder-allow')).toBeNull();
    await click('recorder-choose-file');
    expect(onChooseFile).toHaveBeenCalled();
  });

  it('a dismissed prompt can be asked again', async () => {
    await mount();
    await click('recorder-start');
    await fire('onDenied', false);
    expect(q('recorder-allow')).not.toBeNull();
  });

  it('a sub-second tap returns to a Record button with a toast', async () => {
    await mount();
    await click('recorder-start');
    await fire('onGranted', { getTracks: () => [] });
    await fire('onTooShort');
    expect(q('recorder-start')).not.toBeNull();
    expect(mocks.toastError).toHaveBeenCalled();
  });

  it('Close releases the camera and discards the server folder', async () => {
    await mount();
    await click('recorder-start');
    await fire('onGranted', { getTracks: () => [] });
    await click('recorder-close');
    expect(mocks.cancel).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(async () => root?.unmount());
    root = null;
    expect(mocks.release).toHaveBeenCalled();
  });

  it('keeps the close row and the action row out of the notch and the home bar', async () => {
    // The sheet is full height and its first row is the Close button, so without
    // the top inset that button is under the status bar, and the sheet reads as
    // having no exit. The bottom inset is the same story for Stop and Use clip:
    // on an iPhone the home indicator sits exactly where they would land.
    await mount();
    const html = document.body.innerHTML;
    expect(html).toContain('pt-[env(safe-area-inset-top)]');
    expect(html).toContain('pb-[max(1rem,env(safe-area-inset-bottom))]');
  });
});
