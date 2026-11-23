// makePoster / posterSize.
// protects= a clip always gets a JPEG poster under the server cap: the real frame
// when the canvas works, a placeholder when it does not.
// fails_when= a failed frame grab loses the take, an oversized poster is sent, a
// non-JPEG is returned, or a portrait frame is upscaled.
import { describe, expect, it, vi } from 'vitest';

import { POSTER_MAX_BYTES } from './constants';
import { makePoster, posterSize, type PosterDeps } from './poster';

const blobOf = (size: number, type = 'image/jpeg') => new Blob([new Uint8Array(size)], { type });

function deps(opts: {
  sizes?: number[];
  type?: string;
  noContext?: boolean;
  drawThrows?: boolean;
}): { deps: PosterDeps; created: { width: number; height: number }[]; qualities: number[] } {
  const created: { width: number; height: number }[] = [];
  const qualities: number[] = [];
  let call = 0;
  return {
    created,
    qualities,
    deps: {
      createCanvas(width, height) {
        created.push({ width, height });
        return {
          getContext: () =>
            opts.noContext
              ? null
              : {
                  drawImage: () => {
                    if (opts.drawThrows) throw new DOMException('tainted', 'SecurityError');
                  },
                  fillRect: vi.fn(),
                  fillStyle: '',
                },
          toBlob: (cb: BlobCallback, _t: string, q: number) => {
            qualities.push(q);
            const size = (opts.sizes ?? [50_000])[Math.min(call, (opts.sizes ?? [1]).length - 1)]!;
            call += 1;
            cb(blobOf(size, opts.type));
          },
        } as unknown as HTMLCanvasElement;
      },
    },
  };
}

const video = (w: number, h: number) => ({ videoWidth: w, videoHeight: h }) as HTMLVideoElement;

describe('posterSize', () => {
  it('scales the long edge to 720 and never upscales', () => {
    expect(posterSize(1440, 2560)).toEqual({ width: 405, height: 720 });
    expect(posterSize(320, 240)).toEqual({ width: 320, height: 240 });
  });
  it('falls back to the placeholder size for a zero-size frame', () => {
    expect(posterSize(0, 0)).toEqual({ width: 320, height: 180 });
  });
});

describe('makePoster', () => {
  it('returns the real frame as a JPEG at the scaled size', async () => {
    const d = deps({});
    const poster = await makePoster(video(1440, 2560), d.deps);
    expect(poster.type).toBe('image/jpeg');
    expect(d.created[0]).toEqual({ width: 405, height: 720 });
  });

  it('steps quality down until the poster fits the server cap', async () => {
    const d = deps({ sizes: [POSTER_MAX_BYTES + 1, POSTER_MAX_BYTES + 1, 100_000] });
    const poster = await makePoster(video(720, 1280), d.deps);
    expect(poster.size).toBe(100_000);
    expect(d.qualities).toEqual([0.8, 0.6, 0.4]);
  });

  it.each([
    ['a tainted canvas', { drawThrows: true }],
    ['no 2d context', { noContext: true }],
  ])('falls back to the placeholder on %s', async (_n, opts) => {
    const d = deps(opts);
    const poster = await makePoster(video(720, 1280), d.deps);
    expect(poster.type).toBe('image/jpeg');
    expect(d.created.at(-1)).toEqual({ width: 320, height: 180 });
  });

  it('uses the placeholder when no video element or no frame exists', async () => {
    expect((await makePoster(null, deps({}).deps)).type).toBe('image/jpeg');
    const d = deps({});
    await makePoster(video(0, 0), d.deps);
    expect(d.created.at(-1)).toEqual({ width: 320, height: 180 });
  });

  it('rejects only when the browser cannot encode any JPEG', async () => {
    await expect(makePoster(video(720, 1280), deps({ type: 'image/png' }).deps)).rejects.toThrow(
      /poster/i,
    );
  });
});
