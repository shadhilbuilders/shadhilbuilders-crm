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
  pickRecorderMime,
  queryCameraPermission,
  recorderOptions,
  supportsAudio,
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
