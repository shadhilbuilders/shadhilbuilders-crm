// prepareVideoFile / brandOf.
// protects= a gallery video is refused early, with the right code, when it is too
// big, QuickTime/WebM, unreadable, or outside 1-45 s; an accepted MP4 leaves with
// a poster and its real duration.
// fails_when= an iPhone .mov passes, an oversize file is read at all, or a clip
// over 45 s reaches the upload.
import { describe, expect, it, vi } from 'vitest';

import { MAX_VIDEO_BYTES } from './constants';
import { brandOf, prepareVideoFile, type PrepareDeps } from './prepare-file';

const ftyp = (brand: string) =>
  Uint8Array.from([
    0,
    0,
    0,
    0x18,
    ...'ftyp'.split('').map((c) => c.charCodeAt(0)),
    ...brand.split('').map((c) => c.charCodeAt(0)),
    0,
    0,
    0,
    0,
  ]);
const POSTER = new Blob(['p'], { type: 'image/jpeg' });

function deps(head: Uint8Array, durationMs: number | null = 12_000): PrepareDeps {
  return {
    head: vi.fn(async () => head),
    probe: vi.fn(async () => ({ durationMs, video: {} as HTMLVideoElement })),
    makePoster: vi.fn(async () => POSTER),
  };
}
const file = (size = 1000) => new File([new Uint8Array(size)], 'a.mp4', { type: 'video/mp4' });
const code = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: { code?: string }) => e.code,
  );

describe('brandOf', () => {
  it('reads the ftyp brand, null otherwise', () => {
    expect(brandOf(ftyp('isom'))).toBe('isom');
    expect(brandOf(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(brandOf(new Uint8Array(4))).toBeNull();
  });
});

describe('prepareVideoFile', () => {
  it('accepts an MP4 and returns its real duration and a poster', async () => {
    const clip = await prepareVideoFile(file(), deps(ftyp('mp42'), 12_345));
    expect(clip).toMatchObject({ durationMs: 12_345, hasAudio: false, poster: POSTER });
  });

  it('refuses an oversize file before reading it', async () => {
    const d = deps(ftyp('isom'));
    expect(await code(prepareVideoFile(file(MAX_VIDEO_BYTES + 1), d))).toBe('VIDEO_TOO_LARGE');
    expect(d.head).not.toHaveBeenCalled();
  });

  it.each([
    ['QuickTime from an iPhone library', ftyp('qt  ')],
    ['WebM', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0, 0, 0, 0])],
  ])('refuses %s', async (_n, head) => {
    expect(await code(prepareVideoFile(file(), deps(head)))).toBe('VIDEO_CONTAINER_UNSUPPORTED');
  });

  it('refuses a file the browser cannot decode', async () => {
    expect(await code(prepareVideoFile(file(), deps(ftyp('isom'), null)))).toBe(
      'VIDEO_CONTAINER_UNSUPPORTED',
    );
  });

  it('refuses over 45 seconds and under 1 second', async () => {
    expect(await code(prepareVideoFile(file(), deps(ftyp('isom'), 45_001)))).toBe('VIDEO_TOO_LONG');
    expect(await code(prepareVideoFile(file(), deps(ftyp('isom'), 400)))).toBe('VIDEO_TOO_LONG');
  });
});
