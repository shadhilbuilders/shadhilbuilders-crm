// recorderReducer / announcementFor.
// protects= the legal path from idle to done, each denial/unsupported branch, the
// failure + retry loop, Close discarding the take, audio default OFF and locked
// once recording, and that illegal events change nothing.
// fails_when= a late event revives a closed screen, Retry fires for a
// non-retryable failure, the audio toggle moves mid-recording, or the live region
// speaks seconds.
import { describe, expect, it } from 'vitest';

import {
  INITIAL_RECORDER_STATE,
  announcementFor,
  recorderReducer,
  type Clip,
  type RecorderEvent,
  type RecorderState,
} from './recorder-machine';

const CLIP: Clip = {
  blob: new Blob(['v']),
  durationMs: 12_000,
  hasAudio: false,
  poster: new Blob(['p']),
};

const run = (events: RecorderEvent[], from: RecorderState = INITIAL_RECORDER_STATE) =>
  events.reduce(recorderReducer, from);

const toPreview: RecorderEvent[] = [
  { type: 'OPEN' },
  { type: 'GRANTED' },
  { type: 'STOP' },
  { type: 'STOPPED', clip: CLIP },
];

describe('happy path', () => {
  it('walks idle to done', () => {
    expect(run(toPreview).step.kind).toBe('preview');
    const uploading = run([{ type: 'USE' }], run(toPreview));
    expect(uploading.step).toMatchObject({ kind: 'uploading', percent: 0 });
    const saved = run(
      [{ type: 'PROGRESS', percent: 46 }, { type: 'UPLOADED' }, { type: 'SAVED' }],
      uploading,
    );
    expect(saved.step.kind).toBe('done');
  });
});

describe('permission branches', () => {
  it('temporary denial can be retried; permanent cannot', () => {
    const temp = run([{ type: 'OPEN' }, { type: 'DENIED', permanent: false }]);
    expect(temp.step.kind).toBe('denied-temporary');
    expect(run([{ type: 'OPEN' }], temp).step.kind).toBe('requesting');

    const perm = run([{ type: 'OPEN' }, { type: 'DENIED', permanent: true }]);
    expect(perm.step.kind).toBe('denied-permanent');
    expect(run([{ type: 'OPEN' }], perm)).toBe(perm);
  });

  it('unsupported is terminal until closed', () => {
    const s = run([{ type: 'OPEN' }, { type: 'UNSUPPORTED' }]);
    expect(s.step.kind).toBe('unsupported');
    expect(run([{ type: 'OPEN' }], s)).toBe(s);
    expect(run([{ type: 'CLOSE' }], s).step.kind).toBe('idle');
  });
});

describe('picked clip', () => {
  it('goes from idle straight to preview, and only from idle', () => {
    expect(run([{ type: 'LOAD_CLIP', clip: CLIP }]).step).toMatchObject({
      kind: 'preview',
      clip: CLIP,
    });
    const recording = run([{ type: 'OPEN' }, { type: 'GRANTED' }]);
    expect(run([{ type: 'LOAD_CLIP', clip: CLIP }], recording)).toBe(recording);
  });
});

describe('too short', () => {
  it('returns to idle from recording or stopping, and is ignored elsewhere', () => {
    const recording = run([{ type: 'OPEN' }, { type: 'GRANTED' }]);
    expect(run([{ type: 'TOO_SHORT' }], recording).step.kind).toBe('idle');
    expect(run([{ type: 'STOP' }, { type: 'TOO_SHORT' }], recording).step.kind).toBe('idle');
    expect(run([{ type: 'TOO_SHORT' }])).toBe(INITIAL_RECORDER_STATE);
  });
});

describe('failure and retry', () => {
  const uploading = run([{ type: 'USE' }], run(toPreview));

  it('keeps the clip so a retry re-sends the SAME take', () => {
    const failed = run(
      [{ type: 'FAIL', message: 'Storage is not answering.', retryable: true }],
      uploading,
    );
    expect(failed.step).toMatchObject({ kind: 'failed', retryable: true, clip: CLIP });
    expect(run([{ type: 'RETRY' }], failed).step).toMatchObject({ kind: 'uploading', clip: CLIP });
  });

  it('refuses Retry for a non-retryable failure; Retake still works', () => {
    const failed = run([{ type: 'FAIL', message: 'Too long.', retryable: false }], uploading);
    expect(run([{ type: 'RETRY' }], failed)).toBe(failed);
    expect(run([{ type: 'RETAKE' }], failed).step.kind).toBe('requesting');
  });

  it('can fail while saving as well as uploading', () => {
    const saving = run([{ type: 'UPLOADED' }], uploading);
    expect(run([{ type: 'FAIL', message: 'x', retryable: true }], saving).step.kind).toBe('failed');
  });
});

describe('close, audio, and ignored events', () => {
  it('Close discards the take from any state', () => {
    expect(run([{ type: 'CLOSE' }], run(toPreview)).step).toEqual({ kind: 'idle' });
    expect(run([{ type: 'CLOSE' }], run([{ type: 'OPEN' }, { type: 'GRANTED' }])).step).toEqual({
      kind: 'idle',
    });
  });

  it('audio defaults off, toggles when idle, and is locked while recording', () => {
    expect(INITIAL_RECORDER_STATE.audio).toBe(false);
    const on = run([{ type: 'TOGGLE_AUDIO' }]);
    expect(on.audio).toBe(true);
    const recording = run([{ type: 'OPEN' }, { type: 'GRANTED' }], on);
    expect(run([{ type: 'TOGGLE_AUDIO' }], recording).audio).toBe(true);
  });

  it('ignores events that are illegal in the current state', () => {
    expect(run([{ type: 'STOPPED', clip: CLIP }])).toBe(INITIAL_RECORDER_STATE);
    expect(run([{ type: 'GRANTED' }])).toBe(INITIAL_RECORDER_STATE);
    expect(run([{ type: 'SAVED' }])).toBe(INITIAL_RECORDER_STATE);
    expect(run([{ type: 'USE' }])).toBe(INITIAL_RECORDER_STATE);
    const closed = run([{ type: 'CLOSE' }], run([{ type: 'OPEN' }, { type: 'GRANTED' }]));
    expect(run([{ type: 'STOPPED', clip: CLIP }], closed)).toBe(closed);
  });
});

describe('announcementFor', () => {
  it('speaks states, and a rounded percent, never a timer', () => {
    expect(announcementFor({ kind: 'recording' })).toBe('Recording');
    expect(announcementFor({ kind: 'stopping' })).toBe('Recording stopped');
    expect(announcementFor({ kind: 'uploading', clip: CLIP, percent: 45.6 })).toBe(
      'Uploading, 46 percent',
    );
    expect(announcementFor({ kind: 'uploading', clip: CLIP, percent: null })).toBe('Uploading');
    expect(announcementFor({ kind: 'done' })).toBe('Update saved');
    expect(announcementFor({ kind: 'idle' })).toBe('');
  });
});
