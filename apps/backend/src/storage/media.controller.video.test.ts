// MediaController.read for video clips (site update video, step 6).
// protects= .mp4 keys stream with byte ranges (200/206/416, suffix ranges), are
// access-checked BEFORE any byte is read, and report video/mp4; every other key
// still takes the buffered, sniffed path.
// fails_when= Range is ignored, a denied key streams, a missing clip answers 200,
// a bad Range 500s, or an image key stops being served through `read()`.
// no_claim= the BFF relay (apps/web route tests) and the provider's range maths
// (local-disk.storage.test.ts).
import { PassThrough } from 'node:stream';

import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaController } from './media.controller';

const KEY = 'org-1/up1/clip.mp4';
const BYTES = Buffer.from(Array.from({ length: 100 }, (_, i) => i));

function web(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(buf));
      c.close();
    },
  });
}

function fakeRes() {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  const headers: Record<string, string> = {};
  const res = Object.assign(sink, {
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
  });
  const done = new Promise<void>((resolve) => sink.on('end', resolve).on('close', resolve));
  return { res, headers, done, body: () => Buffer.concat(chunks) };
}

function build() {
  const storage = {
    read: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
    stat: vi.fn(async () => ({ size: 100, mimeType: 'video/mp4', isPrivate: true })),
    readStream: vi.fn(async (_k: string, range?: { start: number; end?: number }) => {
      if (range === undefined) {
        return {
          status: 200 as const,
          headers: { 'content-length': '100', 'accept-ranges': 'bytes' },
          body: web(BYTES),
        };
      }
      if (range.start >= 100) {
        return { status: 416 as const, headers: { 'content-range': 'bytes */100' }, body: null };
      }
      const end = Math.min(range.end ?? 99, 99);
      return {
        status: 206 as const,
        headers: {
          'content-length': String(end - range.start + 1),
          'content-range': `bytes ${range.start}-${end}/100`,
        },
        body: web(BYTES.subarray(range.start, end + 1)),
      };
    }),
  };
  const access = { assertReadable: vi.fn(async () => undefined) };
  const ctrl = new MediaController(storage as never, access as never);
  const read = async (key: string, range?: string) => {
    const r = fakeRes();
    const req = { user: { organizationId: 'org-1' }, headers: range ? { range } : {} };
    await ctrl.read(req as never, encodeURIComponent(key), r.res as never);
    if (r.res.statusCode !== 0) r.res.end();
    await r.done;
    return r;
  };
  return { storage, access, read };
}

let h: ReturnType<typeof build>;
beforeEach(() => {
  h = build();
});

describe('video streaming', () => {
  it('200 with the whole clip and Accept-Ranges when no Range is sent', async () => {
    const r = await h.read(KEY);
    expect(r.res.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('video/mp4');
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.body()).toEqual(BYTES);
  });

  it('206 with the exact slice and Content-Range for bytes=10-19', async () => {
    const r = await h.read(KEY, 'bytes=10-19');
    expect(h.storage.readStream).toHaveBeenCalledWith(KEY, { start: 10, end: 19 });
    expect(r.res.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 10-19/100');
    expect(r.body()).toEqual(BYTES.subarray(10, 20));
  });

  it('206 for an open-ended range (the browser probe bytes=0-)', async () => {
    const r = await h.read(KEY, 'bytes=0-');
    expect(h.storage.readStream).toHaveBeenCalledWith(KEY, { start: 0 });
    expect(r.res.statusCode).toBe(206);
    expect(r.body()).toEqual(BYTES);
  });

  it('resolves a suffix range against the real size', async () => {
    const r = await h.read(KEY, 'bytes=-10');
    expect(h.storage.readStream).toHaveBeenCalledWith(KEY, { start: 90 });
    expect(r.res.statusCode).toBe(206);
    expect(r.body()).toEqual(BYTES.subarray(90));
  });

  it('416 with no body for a range past the end', async () => {
    const r = await h.read(KEY, 'bytes=500-');
    expect(r.res.statusCode).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */100');
    expect(r.body().length).toBe(0);
  });

  it('ignores a malformed or multi-range header and serves the full clip', async () => {
    for (const header of ['bytes=20-10', 'bytes=0-1,5-6', 'junk']) {
      const r = await h.read(KEY, header);
      expect(r.res.statusCode).toBe(200);
      expect(h.storage.readStream).toHaveBeenLastCalledWith(KEY, undefined);
    }
  });

  it('never streams a key the caller may not read', async () => {
    h.access.assertReadable.mockRejectedValueOnce(new NotFoundException('Media not found'));
    await expect(h.read(KEY)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.storage.readStream).not.toHaveBeenCalled();
  });

  it('404 when the clip is not in storage', async () => {
    h.storage.readStream.mockResolvedValueOnce(null as never);
    await expect(h.read(KEY)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404 for a suffix range on a missing clip', async () => {
    h.storage.stat.mockResolvedValueOnce(null as never);
    await expect(h.read(KEY, 'bytes=-10')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('non-video keys', () => {
  it('still use the buffered, sniffed path and ignore Range', async () => {
    const r = await h.read('org-1/up1/poster.jpg', 'bytes=0-1');
    expect(h.storage.readStream).not.toHaveBeenCalled();
    expect(h.storage.read).toHaveBeenCalled();
    expect(r.res.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
  });
});
