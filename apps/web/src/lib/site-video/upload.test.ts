// uploadTake / session helpers.
// protects= both transports end in one `record` call carrying SERVER keys and the
// clip's real size; progress is bytes actually sent; a retry re-sends only what
// is missing and keeps the same upload id and batch id; cancel stops cleanly.
// fails_when= a retry mints a new id, an uploaded object is re-sent, progress
// exceeds 100 or moves backwards, an oversize clip reaches the network, or a
// client-chosen key is sent to `record`.
import { describe, expect, it, vi } from 'vitest';

import { UploadCancelledError, UploadNetworkError } from './errors';
import type { Clip } from './recorder-machine';
import {
  IMAGEKIT_UPLOAD_URL,
  grantStillUsable,
  newSession,
  uploadTake,
  type UploadAuth,
  type UploadDeps,
  type UploadGrant,
  type UploadSession,
} from './upload';

const CLIP: Clip = {
  blob: new Blob([new Uint8Array(900)]),
  durationMs: 12_345.6,
  hasAudio: true,
  poster: new Blob([new Uint8Array(100)], { type: 'image/jpeg' }),
};
const META = {
  unitId: 'u1',
  phaseId: 'ph1',
  takenAt: '2026-11-23T10:00:00+05:30',
  caption: 'Slab',
};
const DIRECT: UploadAuth = {
  transport: 'direct',
  publicKey: 'pub',
  urlEndpoint: 'https://ik.example/x',
  token: 'tok',
  expire: 123,
  signature: 'sig',
  folder: '/org/up1/',
  maxBytes: 14_680_064,
  isPrivateFile: true,
};
const INLINE: UploadAuth = { transport: 'inline', maxBytes: 14_680_064 };
const grant = (auth: UploadAuth): UploadGrant => ({
  uploadId: 'up1',
  auth,
  maxDurationMs: 45_000,
  maxBytes: auth.maxBytes,
});

function makeDeps(overrides: Partial<UploadDeps> = {}) {
  const calls: { path: string; init?: { method?: string; json?: unknown } }[] = [];
  const deps: UploadDeps = {
    api: vi.fn(async (path: string, init?: { method?: string; json?: unknown }) => {
      calls.push({ path, init });
      if (path.includes('/uploads/up1')) {
        const slot = (init?.json as { slot: string }).slot;
        return { key: `org/up1/${slot === 'clip' ? 'clip.mp4' : 'poster.jpg'}` } as never;
      }
      return { id: 'vid-1', kind: 'VIDEO' } as never;
    }),
    postForm: vi.fn(async (_u, form: FormData, onProgress) => {
      const name = String(form.get('fileName'));
      onProgress(1, 2);
      return { filePath: `/org/up1/${name}` };
    }),
    toBase64: vi.fn(async () => 'QUJD'),
    now: () => 1_000,
    randomId: () => 'batch-0001',
    ...overrides,
  };
  return { deps, calls };
}

const session = (auth: UploadAuth) =>
  newSession(grant(auth), { now: () => 1_000, randomId: () => 'batch-0001' });

function run(
  deps: UploadDeps,
  s: UploadSession,
  extra: Partial<Parameters<typeof uploadTake>[0]> = {},
) {
  const progress: number[] = [];
  const sessions: UploadSession[] = [];
  const promise = uploadTake({
    deps,
    meta: META,
    clip: CLIP,
    session: s,
    onProgress: (p) => progress.push(p),
    onSession: (n) => sessions.push(n),
    ...extra,
  });
  return { promise, progress, sessions };
}

describe('direct transport', () => {
  it('posts a signed private form per object, then records server keys', async () => {
    const { deps, calls } = makeDeps();
    const r = run(deps, session(DIRECT));
    await r.promise;

    const forms = vi.mocked(deps.postForm).mock.calls;
    expect(forms).toHaveLength(2);
    const [url, form] = forms[0]!;
    expect(url).toBe(IMAGEKIT_UPLOAD_URL);
    expect(form.get('folder')).toBe('/org/up1/');
    expect(form.get('isPrivateFile')).toBe('true');
    expect(form.get('useUniqueFileName')).toBe('false');
    expect(form.get('signature')).toBe('sig');

    const record = calls.at(-1)!;
    expect(record.path).toBe('/customer-progress/units/u1/videos');
    expect(record.init?.json).toMatchObject({
      uploadId: 'up1',
      key: '/org/up1/clip.mp4',
      posterKey: '/org/up1/poster.jpg',
      batchId: 'batch-0001',
      phaseId: 'ph1',
      sizeBytes: 900,
      durationMs: 12_346,
      hasAudio: true,
      caption: 'Slab',
    });
  });

  it('reports real, monotonic byte progress that ends at 100', async () => {
    const { deps } = makeDeps({
      postForm: vi.fn(async (_u, form: FormData, onProgress) => {
        const size = (form.get('file') as Blob).size;
        onProgress(size / 2, size);
        onProgress(size, size);
        return { filePath: `/org/up1/${String(form.get('fileName'))}` };
      }),
    });
    const r = run(deps, session(DIRECT));
    await r.promise;
    expect(r.progress).toEqual([...r.progress].sort((a, b) => a - b));
    expect(Math.max(...r.progress)).toBe(100);
    expect(r.progress.every((p) => p >= 0 && p <= 100)).toBe(true);
  });
});

describe('inline transport', () => {
  it('posts base64 slots through the API and records the returned keys', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, session(INLINE)).promise;
    expect(deps.postForm).not.toHaveBeenCalled();
    const slots = calls.filter((c) => c.path.includes('/uploads/up1')).map((c) => c.init?.json);
    expect(slots).toEqual([
      { slot: 'clip', base64: 'QUJD' },
      { slot: 'poster', base64: 'QUJD' },
    ]);
    expect(calls.at(-1)!.init?.json).toMatchObject({
      key: 'org/up1/clip.mp4',
      posterKey: 'org/up1/poster.jpg',
    });
  });
});

describe('retry', () => {
  it('re-sends only the missing object and keeps the upload id and batch id', async () => {
    const failing = makeDeps({
      postForm: vi.fn(async (_u, form: FormData, onProgress) => {
        if (form.get('fileName') === 'poster.jpg') throw new UploadNetworkError();
        onProgress(1, 1);
        return { filePath: '/org/up1/clip.mp4' };
      }),
    });
    const first = run(failing.deps, session(DIRECT));
    await expect(first.promise).rejects.toBeInstanceOf(UploadNetworkError);
    // The clip landed before the poster failed: the caller kept that session.
    const kept = first.sessions.at(-1)!;
    expect(kept.clipKey).toBe('/org/up1/clip.mp4');
    expect(kept.posterKey).toBeNull();

    const retry = makeDeps();
    await run(retry.deps, kept).promise;
    const sent = vi.mocked(retry.deps.postForm).mock.calls.map(([, f]) => f.get('fileName'));
    expect(sent).toEqual(['poster.jpg']);
    expect(retry.calls.at(-1)!.init?.json).toMatchObject({
      uploadId: 'up1',
      batchId: 'batch-0001',
    });
  });

  it('a record that already succeeded replays through the same id', async () => {
    const done: UploadSession = {
      ...session(DIRECT),
      clipKey: '/org/up1/clip.mp4',
      posterKey: '/org/up1/poster.jpg',
    };
    const { deps } = makeDeps();
    await run(deps, done).promise;
    expect(deps.postForm).not.toHaveBeenCalled();
    expect(deps.api).toHaveBeenCalledTimes(1);
  });
});

describe('guards', () => {
  it('refuses an oversize clip before any network call', async () => {
    const { deps } = makeDeps();
    const small = { ...session(DIRECT), grant: grant({ ...DIRECT, maxBytes: 500 }) };
    await expect(run(deps, small).promise).rejects.toMatchObject({ code: 'VIDEO_TOO_LARGE' });
    expect(deps.postForm).not.toHaveBeenCalled();
    expect(deps.api).not.toHaveBeenCalled();
  });

  it('stops with UploadCancelledError when aborted, and never records', async () => {
    const controller = new AbortController();
    const { deps, calls } = makeDeps({
      postForm: vi.fn(async () => {
        controller.abort();
        throw new UploadCancelledError();
      }),
    });
    await expect(
      run(deps, session(DIRECT), { signal: controller.signal }).promise,
    ).rejects.toBeInstanceOf(UploadCancelledError);
    expect(calls.some((c) => c.path === '/customer-progress/units/u1/videos')).toBe(false);
  });

  it('omits caption and stage when unset', async () => {
    const { deps, calls } = makeDeps();
    await run(deps, session(INLINE), {
      meta: { unitId: 'u1', phaseId: 'ph1', takenAt: META.takenAt },
    }).promise;
    const body = calls.at(-1)!.init?.json as Record<string, unknown>;
    expect(body).not.toHaveProperty('caption');
    expect(body).not.toHaveProperty('stage');
  });
});

describe('grantStillUsable', () => {
  it('stops trusting a grant before its 600 s expiry', () => {
    const s = session(DIRECT);
    expect(grantStillUsable(s, 1_000 + 100_000)).toBe(true);
    expect(grantStillUsable(s, 1_000 + 560_000)).toBe(false);
  });
});
