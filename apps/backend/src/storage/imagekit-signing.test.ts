// The ImageKit SDK is REAL here (no mock): the one thing step 2 must not get
// wrong is the shape of the signed URL, and a mock cannot prove it. The
// measured failure was that appending `?tr=orig-true` to a signed URL 403s,
// because `ik-s` covers the whole query string.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ImageKitStorage } from './imagekit.storage';

describe('ImageKitStorage signed reads (real SDK)', () => {
  const OLD_ENV = process.env;

  beforeAll(() => {
    process.env = {
      ...OLD_ENV,
      IMAGEKIT_PUBLIC_KEY: 'public_test',
      IMAGEKIT_PRIVATE_KEY: 'private_test',
      IMAGEKIT_URL_ENDPOINT: 'https://ik.imagekit.io/shadhil',
    };
  });
  afterAll(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
  });

  async function fetchedUrl(key: string): Promise<URL> {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('x', { status: 200 }));
    await new ImageKitStorage().readStream(key);
    const raw = spy.mock.calls.at(-1)?.[0];
    spy.mockRestore();
    return new URL(String(raw));
  }

  it('signs a URL whose path already carries orig-true, with expiry and signature', async () => {
    const url = await fetchedUrl('/org-1/up-1/clip.mp4');

    // The SDK puts the transformation in the PATH, which is the form measured
    // against the live CDN (14,268,660 of 14,268,660 bytes, 206 on Range).
    expect(url.origin + url.pathname).toBe(
      'https://ik.imagekit.io/shadhil/tr:orig-true/org-1/up-1/clip.mp4',
    );
    expect(url.searchParams.get('ik-s')).toMatch(/^[0-9a-f]{40}$/);
    expect(Number(url.searchParams.get('ik-t'))).toBeGreaterThan(Date.now() / 1000);
  });

  it('carries nothing but ik-s and ik-t in the query, so nothing is appended after signing', async () => {
    const url = await fetchedUrl('/org-1/up-1/clip.mp4');
    expect([...url.searchParams.keys()].sort()).toEqual(['ik-s', 'ik-t']);
  });

  it('normalises a slashless local-disk style key', async () => {
    const url = await fetchedUrl('org-1/up-1/clip.mp4');
    expect(url.pathname).toBe('/shadhil/tr:orig-true/org-1/up-1/clip.mp4');
  });

  it('gives two different keys two different signatures', async () => {
    const a = await fetchedUrl('/org-1/up-1/a.mp4');
    const b = await fetchedUrl('/org-1/up-1/b.mp4');
    expect(a.searchParams.get('ik-s')).not.toBe(b.searchParams.get('ik-s'));
  });
});
