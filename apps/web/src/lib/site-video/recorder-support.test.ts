// pickRecorderMime / buildConstraints / classifyCameraError / queryCameraPermission.
// protects= the recorder only opens where it can produce MP4, asks for audio only
// when toggled, and tells "dismissed" from "blocked" from "no camera".
// fails_when= a WebM-only browser opens the recorder, audio is requested while
// the toggle is off, or a blocked camera is reported as retryable.
import { describe, expect, it, vi } from 'vitest';

import { RECORDER_MIME, RECORDER_MIME_WITH_AUDIO } from './constants';
import {
  buildConstraints,
  classifyCameraError,
  defaultZoom,
  pickRecorderMime,
  queryCameraPermission,
  readZoomCapability,
  recorderOptions,
  supportsAudio,
  zoomStops,
} from './recorder-support';

const named = (name: string) => Object.assign(new Error(name), { name });

describe('pickRecorderMime', () => {
  it('returns the pinned MP4 type when supported', () => {
    expect(pickRecorderMime({ isTypeSupported: (t) => t === RECORDER_MIME })).toBe(RECORDER_MIME);
  });
  it('is null for a WebM-only browser, and when MediaRecorder is missing', () => {
    expect(pickRecorderMime({ isTypeSupported: (t) => t.startsWith('video/webm') })).toBeNull();
    expect(pickRecorderMime(undefined)).toBeNull();
  });
});

describe('supportsAudio', () => {
  // The exact Chromium answer measured 2026-11-23: avc1 yes, avc1+aac no, and
  // its MediaRecorder then records a SILENT clip with audio requested.
  const videoOnlyMp4 = { isTypeSupported: (t: string) => t === RECORDER_MIME };
  const withAac = { isTypeSupported: (t: string) => t === RECORDER_MIME_WITH_AUDIO };

  it('is false when the recorder can only produce video-only MP4', () => {
    expect(supportsAudio(videoOnlyMp4)).toBe(false);
  });
  it('is true only when avc1 and AAC mux together', () => {
    expect(supportsAudio(withAac)).toBe(true);
    expect(supportsAudio(undefined)).toBe(false);
  });
});

describe('constraints and options', () => {
  it('requests the rear camera at 720p and audio only when on', () => {
    expect(buildConstraints(false).audio).toBe(false);
    expect(buildConstraints(true).audio).toBe(true);
    expect(buildConstraints(false).video).toMatchObject({ facingMode: { ideal: 'environment' } });
  });
  it('sets the audio bitrate only for an audio take', () => {
    expect(recorderOptions(RECORDER_MIME, false)).not.toHaveProperty('audioBitsPerSecond');
    expect(recorderOptions(RECORDER_MIME, true)).toHaveProperty('audioBitsPerSecond');
    expect(recorderOptions(RECORDER_MIME, false).videoBitsPerSecond).toBe(2_500_000);
  });
});

describe('classifyCameraError', () => {
  it('splits a denial by the Permissions API answer', () => {
    expect(classifyCameraError(named('NotAllowedError'), 'denied')).toBe('denied-permanent');
    expect(classifyCameraError(named('NotAllowedError'), 'prompt')).toBe('denied-temporary');
    expect(classifyCameraError(named('NotAllowedError'), null)).toBe('denied-temporary');
  });
  it('treats a missing camera as unsupported and a busy one as retryable', () => {
    expect(classifyCameraError(named('NotFoundError'), null)).toBe('unsupported');
    expect(classifyCameraError(named('NotReadableError'), null)).toBe('denied-temporary');
    expect(classifyCameraError('weird', null)).toBe('denied-temporary');
  });
});

describe('queryCameraPermission', () => {
  it('returns the state, or null when unsupported or throwing', async () => {
    const ok = { query: vi.fn(async () => ({ state: 'denied' }) as PermissionStatus) };
    expect(await queryCameraPermission(ok)).toBe('denied');
    expect(await queryCameraPermission(undefined)).toBeNull();
    const bad = { query: vi.fn(async () => Promise.reject(new TypeError('no camera name'))) };
    expect(await queryCameraPermission(bad)).toBeNull();
  });
});

describe('readZoomCapability', () => {
  const track = (caps: unknown) => ({ getCapabilities: () => caps as never });

  it('reads the device range, defaulting a missing step to 0.1', () => {
    expect(readZoomCapability(track({ zoom: { min: 1, max: 8 } }))).toEqual({
      min: 1,
      max: 8,
      step: 0.1,
    });
    expect(readZoomCapability(track({ zoom: { min: 1, max: 4, step: 0.5 } }))).toEqual({
      min: 1,
      max: 4,
      step: 0.5,
    });
  });

  it('is null on a platform that reports no zoom (iOS Safari)', () => {
    expect(readZoomCapability(track({ facingMode: ['environment'] }))).toBeNull();
  });

  it('is null for a range that cannot zoom, rather than a dead control', () => {
    expect(readZoomCapability(track({ zoom: { min: 1, max: 1 } }))).toBeNull();
    expect(readZoomCapability(track({ zoom: { min: 2 } }))).toBeNull();
    expect(readZoomCapability(track({ zoom: { min: Number.NaN, max: 4 } }))).toBeNull();
    expect(readZoomCapability(null)).toBeNull();
  });

  it('survives a getCapabilities that throws', () => {
    // Some platforms throw here; an unguarded probe would take the recorder down
    // before the first frame.
    const throwing = {
      getCapabilities: () => {
        throw new Error('not supported');
      },
    };
    expect(readZoomCapability(throwing)).toBeNull();
  });
});

describe('defaultZoom', () => {
  it('opens on 1x on a camera that can go wider', () => {
    expect(defaultZoom({ min: 0.5, max: 3, step: 0.1 })).toBe(1);
  });

  it('never asks for a value outside the range', () => {
    expect(defaultZoom({ min: 2, max: 8, step: 0.1 })).toBe(2);
    expect(defaultZoom({ min: 0.2, max: 0.8, step: 0.1 })).toBe(0.8);
  });

  it('snaps to the device grid, rounding down so it never opens tighter than 1x', () => {
    // A grid of 0.3 from 0.5 cannot express 1 exactly: 0.8 is under it, 1.1 is
    // over, and the default must be the one that is not a zoom-in.
    expect(defaultZoom({ min: 0.5, max: 3, step: 0.3 })).toBe(0.8);
  });
});

describe('zoomStops', () => {
  it('offers 1x, 2x and 3x on a range that reaches 3x', () => {
    expect(zoomStops({ min: 1, max: 8, step: 0.1 }).map((s) => s.label)).toEqual([
      '1x',
      '2x',
      '3x',
    ]);
  });

  it('labels the value it actually asks for when the device tops out early', () => {
    // A camera that cannot do 3x must not grow a "3x" button that does 1.5x.
    expect(zoomStops({ min: 1, max: 1.5, step: 0.1 })).toEqual([
      { value: 1, label: '1x' },
      { value: 1.5, label: '1.5x' },
    ]);
  });

  it('snaps to the device grid counted from its own minimum', () => {
    const stops = zoomStops({ min: 0.5, max: 4, step: 0.25 });
    expect(stops.map((s) => s.value)).toEqual([0.5, 1, 1.5]);
    for (const stop of stops) {
      expect(Math.round((stop.value - 0.5) / 0.25)).toBeCloseTo((stop.value - 0.5) / 0.25, 6);
    }
  });

  it('never repeats a stop', () => {
    const values = zoomStops({ min: 1, max: 1.2, step: 0.1 }).map((s) => s.value);
    expect(new Set(values).size).toBe(values.length);
  });
});
