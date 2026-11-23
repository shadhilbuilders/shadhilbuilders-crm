// SiteVideoService (site update video, step 5).
//
// protects= the write path believes nothing the client says: size, privacy and
// container come from storage; keys must sit in the issued folder; the row, the
// audit entry and both ledger charges are one transaction; a replay returns the
// existing row; a client-fault refusal discards the upload and an infrastructure
// failure deletes nothing.
// fails_when= any error code is wrong or missing, a bad upload is saved, a retry
// duplicates a row or deletes the blobs it needs, or a disabled feature answers.
// no_claim= the ledger arithmetic and the SQL (site-video-ledger.db.test.ts), and
// any real ImageKit behaviour (the provider tests).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';

const mocks = vi.hoisted(() => ({
  tx: {
    progressPhoto: { findFirst: vi.fn(), create: vi.fn() },
    phase: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
    $queryRaw: vi.fn(),
  },
  chargeLedgers: vi.fn(),
  assertHeadroom: vi.fn(),
  readTimelinePage: vi.fn(),
}));

vi.mock('@shadhil/database', () => ({
  rlsContextFrom: vi.fn((a: unknown) => a),
  withRlsContext: vi.fn(async (_c: unknown, _ctx: unknown, cb: (t: unknown) => unknown) =>
    cb(mocks.tx),
  ),
}));
vi.mock('./site-video-ledger', () => ({
  chargeLedgers: mocks.chargeLedgers,
  assertHeadroom: mocks.assertHeadroom,
}));
vi.mock('./progress-photo.mapper', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./progress-photo.mapper')>()),
  readTimelinePage: mocks.readTimelinePage,
}));

import { siteVideoError } from './site-video.errors';
import { SiteVideoService } from './site-video.service';
import { issueUploadId } from './site-video-upload-id';
import type { SiteVideoConfig } from './site-video.config';
import { MAX_VIDEO_BYTES } from '../storage/storage.limits';

const ORG = 'org-1';
const UNIT = 'unit-1';
const PROJECT = 'proj-1';
const SECRET = 'service-test-secret-0123456789abcdef';

const actor: JwtPayload = {
  sub: 'eng-1',
  email: 'eng@x.in',
  role: 'ENGINEER',
  organizationId: ORG,
  iat: 0,
  exp: 0,
  iss: 'shadhil-bff',
};

const CONFIG: SiteVideoConfig = {
  enabled: true,
  orgCapBytes: 1_000_000_000,
  projectCapBytes: 500_000_000,
  authPerUserLimit: 20,
  authPerProjectLimit: 100,
  authWindowSeconds: 600,
};

// Real container headers, so the real sniffer runs.
const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')]);
const QT_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ')]);
const WEBM_HEAD = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const SIZE = 5_000_000;

interface FakeObject {
  size: number;
  isPrivate: boolean;
  head: Buffer;
}

function body(head: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(head));
      c.close();
    },
  });
}

function makeStorage(objects: Record<string, FakeObject>, opts: { statThrows?: boolean } = {}) {
  return {
    save: vi.fn(async (data: Buffer, meta: { uploadId?: string; filename: string }) => ({
      key: `${ORG}/${meta.uploadId}/${meta.filename}`,
      mimeType: 'x',
      filename: meta.filename,
      size: data.length,
    })),
    read: vi.fn(),
    delete: vi.fn(),
    deleteUploadFolder: vi.fn(async () => undefined),
    stat: vi.fn(async (key: string) => {
      if (opts.statThrows) throw new Error('imagekit down');
      const o = objects[key];
      return o ? { size: o.size, mimeType: 'x', isPrivate: o.isPrivate } : null;
    }),
    readStream: vi.fn(async (key: string) => {
      const o = objects[key];
      return o ? { status: 206 as const, headers: {}, body: body(o.head) } : null;
    }),
    createUploadAuth: vi.fn((req: { uploadId: string; maxBytes: number }) => ({
      transport: 'inline' as const,
      maxBytes: req.maxBytes,
    })),
  };
}

function build(
  objects: Record<string, FakeObject> = {},
  config: SiteVideoConfig = CONFIG,
  storageOpts: { statThrows?: boolean } = {},
) {
  const storage = makeStorage(objects, storageOpts);
  const progress = {
    assertUnitAccess: vi.fn(async () => ({ projectId: PROJECT, unitNumber: 'A-1' })),
  };
  const limiter = { consume: vi.fn(async () => undefined) };
  const svc = new SiteVideoService(
    { $client: {} } as never,
    storage as never,
    progress as never,
    limiter as never,
    config,
  );
  return { svc, storage, progress, limiter };
}

const scopeFor = (unitId = UNIT) => ({ organizationId: ORG, unitId, userId: actor.sub });

function dtoFor(uploadId: string, overrides: Record<string, unknown> = {}) {
  return {
    uploadId,
    key: `${ORG}/${uploadId}/clip.mp4`,
    posterKey: `${ORG}/${uploadId}/poster.jpg`,
    batchId: 'batch-0001',
    phaseId: 'phase-1',
    sizeBytes: SIZE,
    durationMs: 12_000,
    hasAudio: false,
    takenAt: '2026-11-23T10:00:00+05:30',
    ...overrides,
  };
}

function goodObjects(uploadId: string): Record<string, FakeObject> {
  return {
    [`${ORG}/${uploadId}/clip.mp4`]: { size: SIZE, isPrivate: true, head: MP4_HEAD },
    [`${ORG}/${uploadId}/poster.jpg`]: { size: 40_000, isPrivate: true, head: JPEG_HEAD },
  };
}

const codeOf = (err: unknown): string | undefined =>
  (err as { getResponse?: () => { code?: string } }).getResponse?.().code;

async function failureCode(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: unknown) => codeOf(e),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = SECRET;
  mocks.tx.progressPhoto.findFirst.mockResolvedValue(null);
  mocks.tx.progressPhoto.create.mockResolvedValue({ id: 'vid-1' });
  mocks.tx.phase.findFirst.mockResolvedValue({ name: 'Foundation' });
  mocks.tx.auditLog.create.mockResolvedValue({});
  mocks.tx.$queryRaw.mockResolvedValue([]);
  mocks.chargeLedgers.mockResolvedValue(undefined);
  mocks.assertHeadroom.mockResolvedValue(undefined);
  mocks.readTimelinePage.mockResolvedValue({ photos: [{ id: 'vid-1', kind: 'VIDEO' }] });
});

describe('uploadAuth', () => {
  it('is a 404 when the feature is off, before touching anything', async () => {
    const { svc, progress } = build({}, { ...CONFIG, enabled: false });
    expect(await failureCode(svc.uploadAuth(actor, UNIT))).toBe('VIDEO_CAPTURE_DISABLED');
    expect(progress.assertUnitAccess).not.toHaveBeenCalled();
  });

  it('rate-limits per user and project, checks headroom, and issues a verifiable id', async () => {
    const { svc, limiter, storage } = build();
    const grant = await svc.uploadAuth(actor, UNIT);

    expect(limiter.consume).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: 'eng-1',
      projectId: PROJECT,
    });
    expect(mocks.assertHeadroom).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: ORG, projectId: PROJECT },
      MAX_VIDEO_BYTES,
      { orgCapBytes: CONFIG.orgCapBytes, projectCapBytes: CONFIG.projectCapBytes },
    );
    expect(storage.createUploadAuth).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: grant.uploadId, organizationId: ORG }),
    );
    expect(grant).toMatchObject({ maxBytes: MAX_VIDEO_BYTES, maxDurationMs: 45_000 });
    expect(grant.uploadId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stops at the rate limit before reading the ledger', async () => {
    const { svc, limiter } = build();
    limiter.consume.mockRejectedValueOnce(
      Object.assign(new Error('x'), { getResponse: () => ({ code: 'VIDEO_UPLOAD_RATE_LIMITED' }) }),
    );
    expect(await failureCode(svc.uploadAuth(actor, UNIT))).toBe('VIDEO_UPLOAD_RATE_LIMITED');
    expect(mocks.assertHeadroom).not.toHaveBeenCalled();
  });

  it('refuses a full cap with the cap error, and issues no id', async () => {
    const { svc, storage } = build();
    mocks.assertHeadroom.mockRejectedValueOnce(
      Object.assign(new Error('x'), {
        getResponse: () => ({ code: 'VIDEO_STORAGE_CAP_REACHED' }),
      }),
    );
    expect(await failureCode(svc.uploadAuth(actor, UNIT))).toBe('VIDEO_STORAGE_CAP_REACHED');
    expect(storage.createUploadAuth).not.toHaveBeenCalled();
  });

  it('is STORAGE_UNAVAILABLE when the provider cannot issue grants', async () => {
    const { svc, storage } = build();
    (storage as { createUploadAuth?: unknown }).createUploadAuth = undefined;
    expect(await failureCode(svc.uploadAuth(actor, UNIT))).toBe('STORAGE_UNAVAILABLE');
  });
});

describe('inlineUpload', () => {
  const upload = (svc: SiteVideoService, id: string, slot: 'clip' | 'poster', size = 100) => {
    const head = slot === 'clip' ? MP4_HEAD : JPEG_HEAD;
    const bytes = Buffer.concat([head, Buffer.alloc(Math.max(size - head.length, 0), 1)]);
    return svc.inlineUpload(actor, UNIT, id, { slot, base64: bytes.toString('base64') });
  };

  it('refuses an upload id this server did not issue to this user', async () => {
    const { svc } = build();
    const foreign = issueUploadId({ ...scopeFor(), userId: 'someone-else' });
    expect(await failureCode(upload(svc, foreign, 'clip'))).toBe('VIDEO_UPLOAD_INVALID');
    expect(await failureCode(upload(svc, 'a'.repeat(64), 'clip'))).toBe('VIDEO_UPLOAD_INVALID');
  });

  it('saves into the issued folder under a fixed name, never a client one', async () => {
    const { svc, storage } = build();
    const id = issueUploadId(scopeFor());
    const out = await upload(svc, id, 'clip');
    expect(storage.save).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ organizationId: ORG, uploadId: id, filename: 'clip.mp4' }),
    );
    expect(out.key).toBe(`${ORG}/${id}/clip.mp4`);
  });

  it('refuses when the provider uploads directly instead of inline', async () => {
    const { svc, storage } = build();
    storage.createUploadAuth.mockReturnValue({ transport: 'direct' } as never);
    expect(await failureCode(upload(svc, issueUploadId(scopeFor()), 'clip'))).toBe(
      'VIDEO_INLINE_UNSUPPORTED',
    );
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('refuses an oversized clip and an oversized poster, saving neither', async () => {
    const { svc, storage } = build();
    const id = issueUploadId(scopeFor());
    expect(await failureCode(upload(svc, id, 'clip', MAX_VIDEO_BYTES + 1))).toBe('VIDEO_TOO_LARGE');
    expect(await failureCode(upload(svc, id, 'poster', 2 * 1024 * 1024 + 1))).toBe(
      'VIDEO_POSTER_INVALID',
    );
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('VIDEO_UPLOAD_ID_REUSED once the take is recorded: recorded bytes are frozen', async () => {
    const { svc, storage } = build();
    mocks.tx.progressPhoto.findFirst.mockResolvedValue({ id: 'vid-1' });
    expect(await failureCode(upload(svc, issueUploadId(scopeFor()), 'clip'))).toBe(
      'VIDEO_UPLOAD_ID_REUSED',
    );
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('refuses bytes that are not an MP4 clip or an image poster, saving nothing', async () => {
    const { svc, storage } = build();
    const id = issueUploadId(scopeFor());
    const send = (slot: 'clip' | 'poster', head: Buffer) =>
      svc.inlineUpload(actor, UNIT, id, {
        slot,
        base64: Buffer.concat([head, Buffer.alloc(64, 1)]).toString('base64'),
      });
    expect(await failureCode(send('clip', JPEG_HEAD))).toBe('VIDEO_CONTAINER_UNSUPPORTED');
    expect(await failureCode(send('clip', QT_HEAD))).toBe('VIDEO_CONTAINER_UNSUPPORTED');
    expect(await failureCode(send('poster', MP4_HEAD))).toBe('VIDEO_POSTER_INVALID');
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('is a 404 when the feature is off', async () => {
    const { svc } = build({}, { ...CONFIG, enabled: false });
    expect(await failureCode(upload(svc, 'a'.repeat(64), 'clip'))).toBe('VIDEO_CAPTURE_DISABLED');
  });
});

describe('record: refusals', () => {
  const run = (
    objects: (id: string) => Record<string, FakeObject>,
    over: Record<string, unknown> = {},
    config: SiteVideoConfig = CONFIG,
    storageOpts: { statThrows?: boolean } = {},
  ) => {
    const id = issueUploadId(scopeFor());
    const built = build(objects(id), config, storageOpts);
    const result = failureCode(built.svc.record(actor, UNIT, dtoFor(id, over) as never));
    return { id, result, ...built };
  };

  it('is a 404 when the feature is off', async () => {
    expect(await run(goodObjects, {}, { ...CONFIG, enabled: false }).result).toBe(
      'VIDEO_CAPTURE_DISABLED',
    );
  });

  it('VIDEO_UPLOAD_INVALID for an upload id the server never issued to this user', async () => {
    const built = build();
    const foreign = issueUploadId({ ...scopeFor(), userId: 'someone-else' });
    expect(await failureCode(built.svc.record(actor, UNIT, dtoFor(foreign) as never))).toBe(
      'VIDEO_UPLOAD_INVALID',
    );
    expect(built.storage.stat).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a key in another upload folder',
      (id: string) => ({ key: `${ORG}/${'b'.repeat(64)}/clip.mp4`, id }),
    ],
    ['a key in another organisation', (id: string) => ({ key: `other-org/${id}/clip.mp4` })],
    ['a nested key', (id: string) => ({ key: `${ORG}/${id}/sub/clip.mp4` })],
    ['the poster equal to the clip', (id: string) => ({ posterKey: `${ORG}/${id}/clip.mp4` })],
  ])('VIDEO_UPLOAD_INVALID for %s, without asking storage', async (_n, over) => {
    const id = issueUploadId(scopeFor());
    const built = build(goodObjects(id));
    const code = await failureCode(built.svc.record(actor, UNIT, dtoFor(id, over(id)) as never));
    expect(code).toBe('VIDEO_UPLOAD_INVALID');
    expect(built.storage.stat).not.toHaveBeenCalled();
  });

  it('VIDEO_UPLOAD_INVALID for a phase outside this project', async () => {
    mocks.tx.phase.findFirst.mockResolvedValue(null);
    expect(await run(goodObjects).result).toBe('VIDEO_UPLOAD_INVALID');
  });

  it('VIDEO_TOO_LONG above 45 seconds, before any storage call', async () => {
    const r = run(goodObjects, { durationMs: 45_001 });
    expect(await r.result).toBe('VIDEO_TOO_LONG');
    expect(r.storage.stat).not.toHaveBeenCalled();
  });

  it('VIDEO_UPLOAD_NOT_FOUND when the clip is not in storage', async () => {
    expect(await run(() => ({})).result).toBe('VIDEO_UPLOAD_NOT_FOUND');
  });

  it('VIDEO_NOT_PRIVATE for a public clip, and the upload is discarded', async () => {
    const r = run((id) => ({
      ...goodObjects(id),
      [`${ORG}/${id}/clip.mp4`]: { size: SIZE, isPrivate: false, head: MP4_HEAD },
    }));
    expect(await r.result).toBe('VIDEO_NOT_PRIVATE');
    expect(r.storage.deleteUploadFolder).toHaveBeenCalledWith(ORG, r.id);
  });

  it('VIDEO_NOT_PRIVATE for a public poster too, so the frame cannot leak', async () => {
    const r = run((id) => ({
      ...goodObjects(id),
      [`${ORG}/${id}/poster.jpg`]: { size: 40_000, isPrivate: false, head: JPEG_HEAD },
    }));
    expect(await r.result).toBe('VIDEO_NOT_PRIVATE');
    expect(r.storage.deleteUploadFolder).toHaveBeenCalled();
  });

  it('VIDEO_TOO_LARGE when stat reports more than the cap, whatever the client claimed', async () => {
    const r = run(
      (id) => ({
        ...goodObjects(id),
        [`${ORG}/${id}/clip.mp4`]: { size: MAX_VIDEO_BYTES + 1, isPrivate: true, head: MP4_HEAD },
      }),
      { sizeBytes: 1000 },
    );
    expect(await r.result).toBe('VIDEO_TOO_LARGE');
    expect(r.storage.deleteUploadFolder).toHaveBeenCalled();
  });

  it('VIDEO_SIZE_MISMATCH when the client claim differs from the stored size', async () => {
    const r = run(goodObjects, { sizeBytes: SIZE - 1 });
    expect(await r.result).toBe('VIDEO_SIZE_MISMATCH');
    expect(r.storage.deleteUploadFolder).toHaveBeenCalled();
  });

  it.each([
    ['QuickTime (an iPhone library clip)', QT_HEAD],
    ['WebM', WEBM_HEAD],
    ['a JPEG renamed .mp4', JPEG_HEAD],
  ])('VIDEO_CONTAINER_UNSUPPORTED for %s', async (_n, head) => {
    const r = run((id) => ({
      ...goodObjects(id),
      [`${ORG}/${id}/clip.mp4`]: { size: SIZE, isPrivate: true, head },
    }));
    expect(await r.result).toBe('VIDEO_CONTAINER_UNSUPPORTED');
    expect(r.storage.deleteUploadFolder).toHaveBeenCalled();
  });

  it.each([
    ['a poster that is not an image', { size: 40_000, isPrivate: true, head: MP4_HEAD }],
    ['an empty poster', { size: 0, isPrivate: true, head: JPEG_HEAD }],
    ['an oversized poster', { size: 3 * 1024 * 1024, isPrivate: true, head: JPEG_HEAD }],
  ])('VIDEO_POSTER_INVALID for %s', async (_n, poster) => {
    const r = run((id) => ({ ...goodObjects(id), [`${ORG}/${id}/poster.jpg`]: poster }));
    expect(await r.result).toBe('VIDEO_POSTER_INVALID');
    expect(r.storage.deleteUploadFolder).toHaveBeenCalled();
  });

  it('STORAGE_UNAVAILABLE (retryable) when storage throws, and NOTHING is deleted', async () => {
    const r = run(goodObjects, {}, CONFIG, { statThrows: true });
    expect(await r.result).toBe('STORAGE_UNAVAILABLE');
    expect(r.storage.deleteUploadFolder).not.toHaveBeenCalled();
    expect(mocks.tx.progressPhoto.create).not.toHaveBeenCalled();
  });

  it('writes no row, charge or audit for any refusal', async () => {
    await run(() => ({})).result;
    expect(mocks.chargeLedgers).not.toHaveBeenCalled();
    expect(mocks.tx.progressPhoto.create).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('record: success, replay and failure', () => {
  const go = (id: string, objects = goodObjects(id), over: Record<string, unknown> = {}) => {
    const built = build(objects);
    return { ...built, id, promise: built.svc.record(actor, UNIT, dtoFor(id, over) as never) };
  };

  it('creates the row from SERVER facts, charges the stat size, and audits', async () => {
    const id = issueUploadId(scopeFor());
    const r = go(id);
    const out = await r.promise;

    expect(out).toMatchObject({ replayed: false, photo: { id: 'vid-1' } });
    expect(mocks.chargeLedgers).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: ORG, projectId: PROJECT },
      SIZE,
      { orgCapBytes: CONFIG.orgCapBytes, projectCapBytes: CONFIG.projectCapBytes },
    );
    const data = mocks.tx.progressPhoto.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      kind: 'VIDEO',
      mimeType: 'video/mp4',
      key: `${ORG}/${id}/clip.mp4`,
      posterKey: `${ORG}/${id}/poster.jpg`,
      sizeBytes: SIZE,
      durationMs: 12_000,
      uploadId: id,
      batchId: 'batch-0001',
      hasAudio: false,
      createdBy: 'eng-1',
      organizationId: ORG,
    });
    expect(data.caption).toMatch(/Foundation/);
    expect(mocks.tx.auditLog.create.mock.calls[0][0].data.action).toBe('progress.video_recorded');
    expect(r.storage.deleteUploadFolder).not.toHaveBeenCalled();
  });

  it('uses the engineer note as the caption when one is sent', async () => {
    const id = issueUploadId(scopeFor());
    await go(id, goodObjects(id), { caption: 'Slab poured' }).promise;
    expect(mocks.tx.progressPhoto.create.mock.calls[0][0].data.caption).toBe('Slab poured');
  });

  it('replays the existing row for the same take: no verification, charge or insert', async () => {
    const id = issueUploadId(scopeFor());
    mocks.tx.progressPhoto.findFirst.mockResolvedValue({
      id: 'vid-1',
      key: `${ORG}/${id}/clip.mp4`,
      posterKey: `${ORG}/${id}/poster.jpg`,
    });
    const r = go(id, {});
    expect(await r.promise).toMatchObject({ replayed: true });
    expect(r.storage.stat).not.toHaveBeenCalled();
    expect(mocks.chargeLedgers).not.toHaveBeenCalled();
    expect(mocks.tx.progressPhoto.create).not.toHaveBeenCalled();
  });

  it('VIDEO_UPLOAD_ID_REUSED for a different take under the same id, deleting nothing', async () => {
    const id = issueUploadId(scopeFor());
    mocks.tx.progressPhoto.findFirst.mockResolvedValue({
      id: 'vid-1',
      key: `${ORG}/${id}/other.mp4`,
      posterKey: `${ORG}/${id}/poster.jpg`,
    });
    const r = go(id);
    expect(await failureCode(r.promise)).toBe('VIDEO_UPLOAD_ID_REUSED');
    expect(r.storage.deleteUploadFolder).not.toHaveBeenCalled();
    expect(mocks.tx.progressPhoto.create).not.toHaveBeenCalled();
  });

  it('passes the cap refusal through and deletes nothing: the take may be retried later', async () => {
    mocks.chargeLedgers.mockReset();
    mocks.chargeLedgers.mockRejectedValueOnce(
      siteVideoError('VIDEO_STORAGE_CAP_REACHED', { scope: 'PROJECT' }),
    );
    const id = issueUploadId(scopeFor());
    const r = go(id);
    expect(await failureCode(r.promise)).toBe('VIDEO_STORAGE_CAP_REACHED');
    expect(r.storage.deleteUploadFolder).not.toHaveBeenCalled();
    expect(mocks.tx.progressPhoto.create).not.toHaveBeenCalled();
  });

  it('VIDEO_SAVE_FAILED (retryable) on an unexpected DB failure, deleting NOTHING', async () => {
    mocks.tx.progressPhoto.create.mockRejectedValueOnce(new Error('connection reset'));
    const id = issueUploadId(scopeFor());
    const r = go(id);
    expect(await failureCode(r.promise)).toBe('VIDEO_SAVE_FAILED');
    expect(r.storage.deleteUploadFolder).not.toHaveBeenCalled();
    expect(r.storage.delete).not.toHaveBeenCalled();
  });

  it('takes the per-upload lock and re-checks the clip before committing', async () => {
    const id = issueUploadId(scopeFor());
    const r = go(id);
    await r.promise;
    expect(mocks.tx.$queryRaw).toHaveBeenCalled();
    expect(r.storage.stat.mock.calls.filter(([k]) => k === `${ORG}/${id}/clip.mp4`).length).toBe(2);
  });

  it('VIDEO_UPLOAD_NOT_FOUND, no row and no charge, when a cancel removed the clip mid-record', async () => {
    const id = issueUploadId(scopeFor());
    const r = go(id);
    let calls = 0;
    const original = r.storage.stat.getMockImplementation();
    r.storage.stat.mockImplementation(async (k: string) => {
      calls += 1;
      return calls > 2 ? null : original!(k);
    });
    expect(await failureCode(r.promise)).toBe('VIDEO_UPLOAD_NOT_FOUND');
    expect(mocks.chargeLedgers).not.toHaveBeenCalled();
    expect(mocks.tx.progressPhoto.create).not.toHaveBeenCalled();
  });

  it('does not delete the folder after a client-fault refusal if a twin recorded it meanwhile', async () => {
    const id = issueUploadId(scopeFor());
    const objects = {
      ...goodObjects(id),
      [`${ORG}/${id}/clip.mp4`]: { size: SIZE, isPrivate: false, head: MP4_HEAD },
    };
    const r = go(id, objects);
    // findExisting sees nothing; the re-check inside the discard lock sees the twin's row.
    mocks.tx.progressPhoto.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'twin' });
    expect(await failureCode(r.promise)).toBe('VIDEO_NOT_PRIVATE');
    expect(r.storage.deleteUploadFolder).not.toHaveBeenCalled();
  });

  it('a unique violation from a racing twin resolves to a replay of the winner', async () => {
    const id = issueUploadId(scopeFor());
    mocks.tx.progressPhoto.create.mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    // First lookup (before verify): nothing. Second (after the violation): the winner.
    mocks.tx.progressPhoto.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'vid-1',
      key: `${ORG}/${id}/clip.mp4`,
      posterKey: `${ORG}/${id}/poster.jpg`,
    });
    const r = go(id);
    expect(await r.promise).toMatchObject({ replayed: true });
    expect(r.storage.deleteUploadFolder).not.toHaveBeenCalled();
  });
});

describe('cancel', () => {
  it('refuses an upload id that was not issued to this user', async () => {
    const { svc, storage } = build();
    expect(await failureCode(svc.cancel(actor, UNIT, 'f'.repeat(64)))).toBe('VIDEO_UPLOAD_INVALID');
    expect(storage.deleteUploadFolder).not.toHaveBeenCalled();
  });

  it('deletes only the issued folder for an unrecorded upload', async () => {
    const { svc, storage } = build();
    const id = issueUploadId(scopeFor());
    expect(await svc.cancel(actor, UNIT, id)).toEqual({ cancelled: true });
    expect(storage.deleteUploadFolder).toHaveBeenCalledWith(ORG, id);
  });

  it('never deletes the bytes of a take that was already recorded', async () => {
    const { svc, storage } = build();
    mocks.tx.progressPhoto.findFirst.mockResolvedValue({ id: 'vid-1' });
    const id = issueUploadId(scopeFor());
    expect(await svc.cancel(actor, UNIT, id)).toEqual({ cancelled: false });
    expect(storage.deleteUploadFolder).not.toHaveBeenCalled();
  });

  it('is idempotent: cancelling twice is two successes', async () => {
    const { svc } = build();
    const id = issueUploadId(scopeFor());
    await svc.cancel(actor, UNIT, id);
    await expect(svc.cancel(actor, UNIT, id)).resolves.toEqual({ cancelled: true });
  });

  it('is a 404 when the feature is off', async () => {
    const { svc } = build({}, { ...CONFIG, enabled: false });
    expect(await failureCode(svc.cancel(actor, UNIT, 'a'.repeat(64)))).toBe(
      'VIDEO_CAPTURE_DISABLED',
    );
  });
});
