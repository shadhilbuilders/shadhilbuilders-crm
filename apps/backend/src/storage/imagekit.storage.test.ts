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

// Mock the imagekit SDK (module is a CJS `export = ImageKit` class; the
// `import X from 'imagekit'` resolves to its `.default`, so the factory must
// return the class under `default`).
vi.mock('imagekit', () => ({
  default: class {
    constructor(_opts: object) {}
    upload = uploadMock;
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
});
