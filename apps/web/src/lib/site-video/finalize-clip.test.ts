// finalizeClip.
// protects= every clip leaves with a poster, whether the frame loads, never loads,
// or throws; the clip's own facts pass through untouched.
// fails_when= a frame failure loses the take or leaves poster undefined.
import { describe, expect, it, vi } from 'vitest';

import { finalizeClip } from './finalize-clip';

const TAKE = { blob: new Blob(['v'], { type: 'video/mp4' }), durationMs: 9_000, hasAudio: true };
const POSTER = new Blob(['p'], { type: 'image/jpeg' });

describe('finalizeClip', () => {
  it('attaches the poster made from the loaded frame', async () => {
    const video = {} as HTMLVideoElement;
    const makePoster = vi.fn(async () => POSTER);
    const clip = await finalizeClip(TAKE, { loadFrame: async () => video, makePoster });
    expect(makePoster).toHaveBeenCalledWith(video);
    expect(clip).toEqual({ ...TAKE, poster: POSTER });
  });

  it('still makes a poster (placeholder path) when the frame never loads or throws', async () => {
    const makePoster = vi.fn(async () => POSTER);
    expect((await finalizeClip(TAKE, { loadFrame: async () => null, makePoster })).poster).toBe(
      POSTER,
    );
    const thrown = await finalizeClip(TAKE, {
      loadFrame: async () => Promise.reject(new Error('x')),
      makePoster,
    });
    expect(thrown.poster).toBe(POSTER);
    expect(makePoster).toHaveBeenLastCalledWith(null);
  });
});
