// LocalDiskStorage stat / readStream / createUploadAuth (site update video, step 2).
//
// protects= the dev provider honours the same contract the ImageKit one does:
// real size, 206 with exact Content-Range, 416 outside the object, containment
// on every key - fails_when= a range returns the wrong bytes, an escaping key
// is statted or streamed, or the inline grant loses its ceiling.
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalDiskStorage } from './local-disk.storage';
import { MAX_VIDEO_BYTES } from './storage.limits';

async function drain(body: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  if (body === null) throw new Error('expected a body');
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    chunks.push(value);
  }
}

describe('LocalDiskStorage video seam', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadhil-video-seam-'));
  const storage = new LocalDiskStorage(dir);
  const bytes = Buffer.from('0123456789');
  let key = '';
  let emptyKey = '';

  beforeAll(async () => {
    const meta = { organizationId: 'org-1', mimeType: 'video/mp4' };
    key = (await storage.save(bytes, { ...meta, filename: 'clip.mp4' })).key;
    emptyKey = (await storage.save(Buffer.alloc(0), { ...meta, filename: 'empty.mp4' })).key;
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('stat reports the real size, a mime from the extension, and private', async () => {
    await expect(storage.stat(key)).resolves.toEqual({
      size: 10,
      mimeType: 'video/mp4',
      isPrivate: true,
    });
  });

  it('stat is null for a missing key and for an escaping key', async () => {
    expect(await storage.stat('org-1/none/x.mp4')).toBeNull();
    expect(await storage.stat('../outside.mp4')).toBeNull();
    expect(await storage.stat('/etc/passwd')).toBeNull();
  });

  it('streams the whole object as a 200 with its length', async () => {
    const out = await storage.readStream(key);
    expect(out?.status).toBe(200);
    expect(out?.headers['content-length']).toBe('10');
    expect(out?.headers['accept-ranges']).toBe('bytes');
    expect((await drain(out?.body ?? null)).toString()).toBe('0123456789');
  });

  it('streams a bounded range as a 206 with the exact Content-Range', async () => {
    const out = await storage.readStream(key, { start: 2, end: 5 });
    expect(out?.status).toBe(206);
    expect(out?.headers['content-range']).toBe('bytes 2-5/10');
    expect(out?.headers['content-length']).toBe('4');
    expect((await drain(out?.body ?? null)).toString()).toBe('2345');
  });

  it('streams an open-ended range to the last byte', async () => {
    const out = await storage.readStream(key, { start: 7 });
    expect(out?.headers['content-range']).toBe('bytes 7-9/10');
    expect((await drain(out?.body ?? null)).toString()).toBe('789');
  });

  it('clamps an end past the object instead of failing', async () => {
    const out = await storage.readStream(key, { start: 8, end: 999 });
    expect(out?.status).toBe(206);
    expect(out?.headers['content-range']).toBe('bytes 8-9/10');
  });

  it('answers 416 with no body when the range starts past the end', async () => {
    const out = await storage.readStream(key, { start: 10 });
    expect(out).toMatchObject({ status: 416, body: null });
    expect(out?.headers['content-range']).toBe('bytes */10');
  });

  it('answers 416 for an inverted or negative range', async () => {
    expect((await storage.readStream(key, { start: 5, end: 2 }))?.status).toBe(416);
    expect((await storage.readStream(key, { start: -1 }))?.status).toBe(416);
  });

  it('streams an empty object as an empty 200, and 416s any range on it', async () => {
    const whole = await storage.readStream(emptyKey);
    expect(whole?.status).toBe(200);
    expect((await drain(whole?.body ?? null)).length).toBe(0);
    expect((await storage.readStream(emptyKey, { start: 0 }))?.status).toBe(416);
  });

  it('readStream is null for a missing or escaping key', async () => {
    expect(await storage.readStream('org-1/none/x.mp4')).toBeNull();
    expect(await storage.readStream('../outside.mp4')).toBeNull();
  });

  it('createUploadAuth is the inline branch carrying the requested ceiling', () => {
    expect(
      storage.createUploadAuth({
        organizationId: 'org-1',
        uploadId: 'up-1',
        maxBytes: MAX_VIDEO_BYTES,
      }),
    ).toEqual({ transport: 'inline', maxBytes: 14_680_064 });
  });

  it('save into a server-issued folder, then deleteUploadFolder removes all of it', async () => {
    const meta = { organizationId: 'org-9', mimeType: 'video/mp4', uploadId: 'up'.padEnd(64, 'a') };
    const clip = await storage.save(bytes, { ...meta, filename: 'clip.mp4' });
    const poster = await storage.save(bytes, { ...meta, filename: 'poster.jpg' });
    expect(clip.key).toBe(`org-9/${meta.uploadId}/clip.mp4`);
    expect(poster.key).toBe(`org-9/${meta.uploadId}/poster.jpg`);

    await storage.deleteUploadFolder('org-9', meta.uploadId);
    expect(await storage.stat(clip.key)).toBeNull();
    expect(await storage.stat(poster.key)).toBeNull();
  });

  it('deleteUploadFolder leaves a sibling upload alone and resolves for a missing folder', async () => {
    const other = await storage.save(bytes, {
      organizationId: 'org-9',
      mimeType: 'video/mp4',
      filename: 'keep.mp4',
      uploadId: 'bb'.padEnd(64, 'b'),
    });
    await expect(
      storage.deleteUploadFolder('org-9', 'cc'.padEnd(64, 'c')),
    ).resolves.toBeUndefined();
    expect(await storage.stat(other.key)).not.toBeNull();
  });

  it('deleteUploadFolder refuses a traversal id instead of escaping the root', async () => {
    await expect(storage.deleteUploadFolder('org-1', '../..')).resolves.toBeUndefined();
    expect(await storage.stat(key)).not.toBeNull();
  });
});
