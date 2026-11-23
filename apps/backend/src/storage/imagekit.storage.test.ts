// Unit tests for the imagekit.io StorageProvider adapter.
//
// The adapter is a thin wrapper over the `imagekit` SDK: we mock the SDK
// module so no credentials or network are needed (the constructor's
// fail-fast guard is exercised separately via real env).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageKitStorage } from './imagekit.storage';

// Hoisted so the vi.mock factory can reference it (vi.mock is hoisted to the
// top of the module, before `const uploadMock` would otherwise be assigned).
const uploadMock = vi.hoisted(() => vi.fn());
const listFilesMock = vi.hoisted(() => vi.fn());
const deleteFileMock = vi.hoisted(() => vi.fn());
const urlMock = vi.hoisted(() =>
  vi.fn(
    (o: { path: string }) => `https://ik.imagekit.io/org${o.path}?tr=orig-true&ik-s=sig&ik-t=999`,
  ),
);
const authMock = vi.hoisted(() => vi.fn());

// Mock the imagekit SDK (module is a CJS `export = ImageKit` class; the
// `import X from 'imagekit'` resolves to its `.default`, so the factory must
// return the class under `default`).
vi.mock('imagekit', () => ({
  default: class {
    constructor(_opts: object) {}
    upload = uploadMock;
    listFiles = listFilesMock;
    deleteFile = deleteFileMock;
    url = urlMock;
    getAuthenticationParameters = authMock;
  },
}));

describe('ImageKitStorage', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, IMAGEKIT_URL_ENDPOINT: 'https://ik.imagekit.io/org' };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('throws fail-fast when required env is missing', () => {
    delete process.env.IMAGEKIT_PUBLIC_KEY;
    delete process.env.IMAGEKIT_PRIVATE_KEY;
    delete process.env.IMAGEKIT_URL_ENDPOINT;
    expect(() => new ImageKitStorage()).toThrow(/IMAGEKIT_PUBLIC_KEY/);
  });

  it('uploads and returns an imagekit filePath as the key', async () => {
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    uploadMock.mockResolvedValue({
      filePath: '/shadhil-org/abc123/photo.png',
      fileId: 'f_123',
    });

    const s = new ImageKitStorage();
    const stored = await s.save(Buffer.from('x'), {
      organizationId: 'org-1',
      mimeType: 'image/png',
      filename: 'photo.png',
    });

    expect(stored.key).toBe('/shadhil-org/abc123/photo.png');
    expect(stored.mimeType).toBe('image/png');
    expect(stored.filename).toBe('photo.png');
    expect(stored.size).toBe(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0][0].file).toEqual(Buffer.from('x'));
    expect(uploadMock.mock.calls[0][0].folder).toMatch(/^\/org-1\//);
    expect(uploadMock.mock.calls[0][0].useUniqueFileName).toBe(true);
  });

  it('uses a safe filename (traversal tokens stripped)', async () => {
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    uploadMock.mockResolvedValue({ filePath: '/x/y/z..png' });

    const s = new ImageKitStorage();
    await s.save(Buffer.from('x'), {
      organizationId: 'org-1',
      mimeType: 'image/png',
      filename: '../photo.png',
    });

    expect(uploadMock.mock.calls[0][0].fileName).toBe('.._photo.png');
  });

  it('returns a null publicUrl when no endpoint is set', () => {
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    const s = new ImageKitStorage();
    // Endpoint set at construction; then the env is removed so publicUrl can't
    // build a URL. (Constructor still needs endpoint present to survive.)
    delete process.env.IMAGEKIT_URL_ENDPOINT;
    expect(s.publicUrl('/org/a/b.png')).toBeNull();
  });

  it('builds a public CDN url by prefining the endpoint', () => {
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    const s = new ImageKitStorage();
    expect(s.publicUrl('/org/a/b.png')).toBe('https://ik.imagekit.io/org/org/a/b.png');
  });

  // REGRESSION (2026-11-06). A LocalDisk-format key has NO leading slash
  // (`<org>/<cuid>/<name>`). `endpoint + key` glued them together into
  // `https://ik.imagekit.io/orgorg/...`, which 404s with no hint why. Rows
  // written under MEDIA_STORAGE=local are read through THIS adapter after a
  // provider switch, so both key shapes must produce a valid URL.
  it('inserts the separator for a slashless (LocalDisk-shaped) key', () => {
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    const s = new ImageKitStorage();
    expect(s.publicUrl('org/a/b.png')).toBe('https://ik.imagekit.io/org/org/a/b.png');
    // The glued form must never appear.
    expect(s.publicUrl('org/a/b.png')).not.toContain('orgorg');
  });

  it('tolerates a trailing slash on the endpoint without doubling it', () => {
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    process.env.IMAGEKIT_URL_ENDPOINT = 'https://ik.imagekit.io/org///';
    try {
      const s = new ImageKitStorage();
      expect(s.publicUrl('/org/a/b.png')).toBe('https://ik.imagekit.io/org/org/a/b.png');
      expect(s.publicUrl('org/a/b.png')).toBe('https://ik.imagekit.io/org/org/a/b.png');
    } finally {
      process.env.IMAGEKIT_URL_ENDPOINT = 'https://ik.imagekit.io/org';
    }
  });

  it('returns null from read() when the fetch fails', async () => {
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    const s = new ImageKitStorage();
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 404 } as Response);
    expect(await s.read('/org/a/b.png')).toBeNull();
  });

  it('returns the raw bytes from read() on a 200 response', async () => {
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    const s = new ImageKitStorage();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    } as unknown as Response);
    expect(await s.read('/org/a/b.png')).toEqual(Buffer.from([1, 2, 3]));
  });

  it('requests ?tr=orig-true so ImageKit does not re-encode the bytes', async () => {
    // Verified against the real CDN: a bare URL returned a 457KB JPEG for a
    // stored 1MB PNG. Without this parameter read() hands a lossy derivative to
    // the outbound Meta /media upload.
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    const s = new ImageKitStorage();
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    } as unknown as Response);

    await s.read('/org/a/b.txt');

    // The transformation rides INSIDE a signed URL, built once by the SDK.
    expect(urlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/org/a/b.txt',
        signed: true,
        transformation: [{ raw: 'orig-true' }],
      }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://ik.imagekit.io/org/org/a/b.txt?tr=orig-true&ik-s=sig&ik-t=999',
    );
  });

  it('serves JPEG bytes stored under a .png key instead of refusing', async () => {
    // REGRESSION GUARD (2026-11-06). The adapter used to return null here,
    // reasoning that "JPEG bytes under a .png key" proved ?tr=orig-true was
    // being ignored. It is not: phones name a JPEG `IMG_2676.PNG`, and
    // ImageKit faithfully stores those bytes. Verified against the live CDN -
    // orig-true returned the stored 27,711-byte JPEG while the bare URL
    // returned a 16,473-byte derivative, so the parameter IS honoured. The
    // filename is a label; the bytes are the truth.
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    const s = new ImageKitStorage();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(jpeg.buffer),
    } as unknown as Response);

    expect(await s.read('/org/a/photo.png')).toEqual(Buffer.from(jpeg));
  });

  it('serves genuine PNG bytes for a .png key', async () => {
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    const s = new ImageKitStorage();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(png.buffer),
    } as unknown as Response);

    expect(await s.read('/org/a/photo.png')).toEqual(Buffer.from(png));
  });

  it('delete(): looks the fileId up by folder+name and deletes it', async () => {
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    listFilesMock.mockResolvedValue({
      response: [{ fileId: 'f_9', filePath: '/org-1/abc/photo.png', type: 'file' }],
    });
    deleteFileMock.mockResolvedValue({});

    const s = new ImageKitStorage();
    await s.delete('/org-1/abc/photo.png');

    expect(listFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/org-1/abc', name: 'photo.png' }),
    );
    expect(deleteFileMock).toHaveBeenCalledWith('f_9');
  });

  it('delete(): a missing file resolves silently (nothing to compensate)', async () => {
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    listFilesMock.mockResolvedValue({ response: [] });

    const s = new ImageKitStorage();
    await expect(s.delete('/org-1/abc/never.png')).resolves.toBeUndefined();
    expect(deleteFileMock).not.toHaveBeenCalled();
  });

  it('delete(): an API error logs and resolves - never throws to the compensation caller', async () => {
    process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
    process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
    listFilesMock.mockRejectedValue(new Error('ik down'));

    const s = new ImageKitStorage();
    await expect(s.delete('/org-1/abc/photo.png')).resolves.toBeUndefined();
  });

  describe('video seam (site update video, step 2)', () => {
    function make(): ImageKitStorage {
      process.env.IMAGEKIT_PUBLIC_KEY = 'pub';
      process.env.IMAGEKIT_PRIVATE_KEY = 'priv';
      return new ImageKitStorage();
    }

    function streamOf(bytes: number[]): ReadableStream<Uint8Array> {
      return new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(bytes));
          c.close();
        },
      });
    }

    it('stat reports the stored size, mime and privacy from the exact path', async () => {
      listFilesMock.mockResolvedValue([
        { type: 'file', filePath: '/org-1/u1/other.mp4', size: 1, mime: 'video/mp4' },
        {
          type: 'file',
          filePath: '/org-1/u1/clip.mp4',
          size: 14268660,
          mime: 'video/mp4',
          isPrivateFile: true,
        },
      ]);
      await expect(make().stat('/org-1/u1/clip.mp4')).resolves.toEqual({
        size: 14268660,
        mimeType: 'video/mp4',
        isPrivate: true,
      });
    });

    it('stat treats a missing privacy flag as PUBLIC, never private', async () => {
      listFilesMock.mockResolvedValue([
        { type: 'file', filePath: '/o/u/c.mp4', size: 5, mime: 'video/mp4' },
      ]);
      expect((await make().stat('/o/u/c.mp4'))?.isPrivate).toBe(false);
    });

    it('stat is null for an absent key and for an SDK failure', async () => {
      listFilesMock.mockResolvedValueOnce([]);
      expect(await make().stat('/o/u/none.mp4')).toBeNull();
      listFilesMock.mockRejectedValueOnce(new Error('boom'));
      expect(await make().stat('/o/u/c.mp4')).toBeNull();
    });

    it('readStream sends the range and reports 206 with the range headers', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(streamOf([1, 2]), {
          status: 206,
          headers: {
            'content-range': 'bytes 1000-2000/14268660',
            'content-length': '1001',
            'accept-ranges': 'bytes',
            'set-cookie': 'secret=1',
          },
        }),
      );
      const out = await make().readStream('/o/u/c.mp4', { start: 1000, end: 2000 });

      expect(fetchSpy.mock.calls[0][1]).toEqual({ headers: { range: 'bytes=1000-2000' } });
      expect(out?.status).toBe(206);
      expect(out?.headers['content-range']).toBe('bytes 1000-2000/14268660');
      expect(out?.headers['set-cookie']).toBeUndefined();
      expect(out?.body).not.toBeNull();
    });

    it('readStream uses an open-ended range and never leaks the signed URL', async () => {
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(streamOf([1]), { status: 206 }));
      const out = await make().readStream('/o/u/c.mp4', { start: 5000000 });

      expect(fetchSpy.mock.calls[0][1]).toEqual({ headers: { range: 'bytes=5000000-' } });
      expect(JSON.stringify(out?.headers)).not.toMatch(/ik-s|ik-t|signature/);
    });

    it('readStream with no range is a 200 and sends no Range header', async () => {
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(streamOf([1]), { status: 200 }));
      const out = await make().readStream('/o/u/c.mp4');

      expect(fetchSpy.mock.calls[0][1]).toEqual({ headers: {} });
      expect(out?.status).toBe(200);
    });

    it('readStream reports a 200 honestly when upstream ignored the range', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response(streamOf([1]), { status: 200 }));
      expect((await make().readStream('/o/u/c.mp4', { start: 1, end: 2 }))?.status).toBe(200);
    });

    it('readStream surfaces 416 with no body, and null on an upstream 403', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(
        new Response(null, { status: 416, headers: { 'content-range': 'bytes */10' } }),
      );
      const bad = await make().readStream('/o/u/c.mp4', { start: 99 });
      expect(bad).toEqual({ status: 416, headers: { 'content-range': 'bytes */10' }, body: null });

      vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('no', { status: 403 }));
      expect(await make().readStream('/o/u/c.mp4')).toBeNull();
    });

    it('createUploadAuth issues a private direct grant scoped to the folder', () => {
      authMock.mockReturnValue({ token: 'tok', signature: 'sig', expire: 0 });
      const before = Math.floor(Date.now() / 1000);
      const auth = make().createUploadAuth({
        organizationId: 'org-1',
        uploadId: 'up-1',
        maxBytes: 14680064,
      });

      expect(auth).toMatchObject({
        transport: 'direct',
        publicKey: 'pub',
        urlEndpoint: 'https://ik.imagekit.io/org',
        token: 'tok',
        signature: 'sig',
        folder: '/org-1/up-1/',
        maxBytes: 14680064,
        isPrivateFile: true,
      });
      if (auth.transport !== 'direct') throw new Error('expected direct');
      expect(auth.expire).toBeGreaterThanOrEqual(before + 600);
      expect(auth.expire).toBeLessThanOrEqual(before + 602);
      expect(JSON.stringify(auth)).not.toContain('priv');
    });
  });
});
