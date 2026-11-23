// Photo correction authority (slice 4, 2026-11-07).
//
// The grant already existed in the database and consumed nothing: no route used
// progress_photo_update / progress_photo_delete, so flipping the "Photo lead"
// switch changed behaviour for nobody.
//
// protects= the edit/delete authority that RLS expresses (ADMIN, the CREATOR,
//           the project's PHOTO_LEAD) is exercised by a real route, the caption
//           is the ONLY editable field, and a delete removes row then bytes;
// fails_when= a non-owner edits or deletes, a denied actor is told 403 instead
//           of 404 (which would confirm the row exists), phase/takenAt/unitId
//           become editable, a blob delete failure loses the audit row, or the
//           row is deleted before the audit is written;
// no_claim= the RLS arms themselves are proven in packages/database/test/*;
//           here the RLS transaction is stubbed, so a green run says the SERVICE
//           delegates authority correctly - not that Postgres agrees.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';

const mocks = vi.hoisted(() => ({
  tx: {
    progressPhoto: {
      findFirst: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $executeRaw: vi.fn(),
  },
  storageDelete: vi.fn(),
}));

vi.mock('@shadhil/database', async (importOriginal) => {
  // Keep the real `Prisma` (sql tag) so the ledger credit builds its statement;
  // only the RLS wrappers are faked.
  const actual = await importOriginal<typeof import('@shadhil/database')>();
  return {
    ...actual,
    rlsContextFrom: vi.fn((a: unknown) => a),
    withRlsContext: vi.fn(async (_c: unknown, _ctx: unknown, cb: (t: unknown) => unknown) =>
      cb(mocks.tx),
    ),
  };
});

import { CustomerProgressService, UpdatePhotoSchema } from './customer-progress.service';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const actor = (role: JwtPayload['role'], sub = 'u-1'): JwtPayload => ({
  sub,
  email: `${sub}@x.in`,
  role,
  organizationId: ORG,
  iat: 0,
  exp: 0,
  iss: 'shadhil-bff',
});

const PHOTO = {
  id: 'photo-1',
  unitId: 'unit-1',
  key: `${ORG}/abc/site.jpg`,
  posterKey: null as string | null,
  sizeBytes: null as number | null,
  unit: { phase: { projectId: 'proj-1' } },
  caption: 'Foundation October 2026',
};

const svc = () =>
  new CustomerProgressService(
    { $client: {} } as never,
    { save: vi.fn(), read: vi.fn(), delete: mocks.storageDelete, publicUrl: vi.fn() } as never,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tx.progressPhoto.findFirst.mockResolvedValue({ ...PHOTO });
  mocks.tx.progressPhoto.update.mockResolvedValue({ ...PHOTO });
  mocks.tx.progressPhoto.deleteMany.mockResolvedValue({ count: 1 });
  mocks.tx.auditLog.create.mockResolvedValue({});
  mocks.storageDelete.mockResolvedValue(undefined);
  // The update path re-reads through the shared mapper to emit the timeline DTO.
  mocks.tx.progressPhoto.findMany.mockResolvedValue([
    {
      id: 'photo-1',
      unitId: 'unit-1',
      phaseId: 'ph1',
      phase: { name: 'Foundation' },
      mimeType: 'image/jpeg',
      filename: 'site.jpg',
      caption: 'Corrected caption',
      takenAt: new Date('2026-10-01T00:00:00Z'),
      createdAt: new Date('2026-10-01T00:00:00Z'),
      key: PHOTO.key,
    },
  ]);
  mocks.tx.$queryRaw.mockResolvedValue([{ creator_name: 'Ravi', creator_is_photo_lead: false }]);
});

describe('UpdatePhotoSchema', () => {
  it('accepts a normal caption', () => {
    expect(UpdatePhotoSchema.safeParse({ caption: 'Plinth slab poured' }).success).toBe(true);
  });

  it('fails_when= an empty or whitespace-only caption is accepted', () => {
    expect(UpdatePhotoSchema.safeParse({ caption: '' }).success).toBe(false);
    expect(UpdatePhotoSchema.safeParse({ caption: '   ' }).success).toBe(false);
  });

  it('fails_when= an over-long caption is accepted', () => {
    expect(UpdatePhotoSchema.safeParse({ caption: 'x'.repeat(201) }).success).toBe(false);
    expect(UpdatePhotoSchema.safeParse({ caption: 'x'.repeat(200) }).success).toBe(true);
  });

  // The editable surface is caption and nothing else.
  it('fails_when= phaseId, takenAt or unitId are accepted as editable', () => {
    const parsed = UpdatePhotoSchema.safeParse({
      caption: 'ok',
      phaseId: 'other-phase',
      takenAt: '2020-01-01T00:00:00Z',
      unitId: 'other-unit',
    });
    expect(parsed.success).toBe(true);
    // zod strips unknown keys, so the DTO can never carry them onward.
    expect(Object.keys(parsed.success ? parsed.data : {})).toEqual(['caption']);
  });
});

describe('updatePhoto', () => {
  it('protects= an authorised actor changes the caption and the change is audited', async () => {
    const result = await svc().updatePhoto(actor('ENGINEER'), 'photo-1', {
      caption: 'Corrected caption',
    });

    expect(mocks.tx.progressPhoto.update).toHaveBeenCalledWith({
      where: { id: 'photo-1' },
      data: { caption: 'Corrected caption' },
    });
    const audit = mocks.tx.auditLog.create.mock.calls[0]?.[0] as {
      data: { action: string; before: unknown; after: unknown };
    };
    expect(audit.data.action).toBe('progress.photo_caption_updated');
    expect(audit.data.before).toEqual({ caption: PHOTO.caption });
    expect(audit.data.after).toEqual({ caption: 'Corrected caption' });
    // Same DTO shape the timeline renders, so the client can swap the row.
    expect(result.id).toBe('photo-1');
    expect(result.mediaUrl).toContain('/api/bff/media/');
  });

  it('fails_when= a photo the actor cannot see is edited (404, not 403)', async () => {
    mocks.tx.progressPhoto.findFirst.mockResolvedValue(null);
    const err = await svc()
      .updatePhoto(actor('TELECALLER'), 'photo-x', { caption: 'hijack' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getStatus()).toBe(404);
    expect(mocks.tx.progressPhoto.update).not.toHaveBeenCalled();
  });

  it('fails_when= the lookup is not org-scoped', async () => {
    await svc().updatePhoto(actor('ADMIN'), 'photo-1', { caption: 'ok' });
    expect(mocks.tx.progressPhoto.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'photo-1', organizationId: ORG }),
      }),
    );
  });

  it('fails_when= the row is written without an audit entry', async () => {
    mocks.tx.auditLog.create.mockRejectedValueOnce(new Error('audit down'));
    await expect(svc().updatePhoto(actor('ADMIN'), 'photo-1', { caption: 'ok' })).rejects.toThrow(
      /audit down/,
    );
  });
});

describe('deletePhoto', () => {
  it('protects= an authorised actor deletes the row, audits it, then removes the bytes', async () => {
    const result = await svc().deletePhoto(actor('ADMIN'), 'photo-1');

    expect(mocks.tx.progressPhoto.deleteMany).toHaveBeenCalledWith({ where: { id: 'photo-1' } });
    const audit = mocks.tx.auditLog.create.mock.calls[0]?.[0] as {
      data: { action: string; before: { key: string } };
    };
    expect(audit.data.action).toBe('progress.photo_deleted');
    // Key recorded so an operator can find the blob if compensation failed.
    expect(audit.data.before.key).toBe(PHOTO.key);
    expect(mocks.storageDelete).toHaveBeenCalledWith(PHOTO.key);
    expect(result).toEqual({ id: 'photo-1', unitId: 'unit-1' });
  });

  // Ordering matters: a blob delete that ran first would leave a row pointing
  // at bytes that are gone if the row delete then failed.
  it('fails_when= the bytes are removed before the row commits', async () => {
    let deleteCalled = false;
    mocks.storageDelete.mockImplementation(async () => {
      deleteCalled = mocks.tx.progressPhoto.deleteMany.mock.calls.length > 0;
    });
    await svc().deletePhoto(actor('ADMIN'), 'photo-1');
    expect(deleteCalled).toBe(true);
  });

  it('fails_when= a blob failure loses the row delete or the audit row', async () => {
    mocks.storageDelete.mockRejectedValue(new Error('storage down'));

    await expect(svc().deletePhoto(actor('ADMIN'), 'photo-1')).resolves.toEqual({
      id: 'photo-1',
      unitId: 'unit-1',
    });
    expect(mocks.tx.progressPhoto.deleteMany).toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).toHaveBeenCalled();
  });

  it('fails_when= a photo the actor cannot see is deleted (404, and no blob delete)', async () => {
    // findFirst returns null (RLS hides it) -> 404 before any write.
    mocks.tx.progressPhoto.findFirst.mockResolvedValue(null);
    await expect(svc().deletePhoto(actor('ENGINEER'), 'photo-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mocks.tx.progressPhoto.deleteMany).not.toHaveBeenCalled();
    expect(mocks.storageDelete).not.toHaveBeenCalled();
  });

  // deleteMany (not delete) so an RLS-denied row is a 0-count, not a P2025
  // that surfaces as a 500.
  it('fails_when= a denied row surfaces as a server error instead of a 404', async () => {
    mocks.tx.progressPhoto.deleteMany.mockResolvedValue({ count: 0 });
    const err = await svc()
      .deletePhoto(actor('ADMIN'), 'photo-1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(mocks.storageDelete).not.toHaveBeenCalled();
  });
});

describe('deletePhoto - video rows (site update video, step 5)', () => {
  const VIDEO = {
    ...PHOTO,
    key: `${ORG}/up1/clip.mp4`,
    posterKey: `${ORG}/up1/poster.jpg`,
  };

  it('protects= a video deletes BOTH the clip and its poster, and audits both keys', async () => {
    mocks.tx.progressPhoto.findFirst.mockResolvedValue(VIDEO);

    await svc().deletePhoto(actor('ADMIN'), 'photo-1');

    expect(mocks.storageDelete).toHaveBeenCalledTimes(2);
    expect(mocks.storageDelete).toHaveBeenCalledWith(VIDEO.key);
    expect(mocks.storageDelete).toHaveBeenCalledWith(VIDEO.posterKey);
    const audit = mocks.tx.auditLog.create.mock.calls[0]?.[0] as {
      data: { before: { key: string; posterKey: string } };
    };
    expect(audit.data.before).toMatchObject({ key: VIDEO.key, posterKey: VIDEO.posterKey });
  });

  it('protects= deleting a video credits the clip bytes back to both ledgers in the same transaction', async () => {
    mocks.tx.progressPhoto.findFirst.mockResolvedValue({ ...VIDEO, sizeBytes: 5_000_000 });

    await svc().deletePhoto(actor('ADMIN'), 'photo-1');

    // One statement for the org ledger, one for the project ledger.
    expect(mocks.tx.$executeRaw).toHaveBeenCalledTimes(2);
    const sql = mocks.tx.$executeRaw.mock.calls
      .map((c) => (c[0] as { strings: string[] }).strings.join('?'))
      .join('\n');
    expect(sql).toContain('"StorageUsage"');
    expect(sql).toContain('"ProjectStorageUsage"');
    expect(sql).toContain('GREATEST');
  });

  it('fails_when= a photo delete touches the ledgers', async () => {
    await svc().deletePhoto(actor('ADMIN'), 'photo-1');
    expect(mocks.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('fails_when= a failed clip delete stops the poster delete', async () => {
    mocks.tx.progressPhoto.findFirst.mockResolvedValue(VIDEO);
    mocks.storageDelete.mockRejectedValueOnce(new Error('storage down'));

    await expect(svc().deletePhoto(actor('ADMIN'), 'photo-1')).resolves.toEqual({
      id: 'photo-1',
      unitId: 'unit-1',
    });
    expect(mocks.storageDelete).toHaveBeenCalledTimes(2);
  });

  it('deletes only the poster for a clip whose key was already purged', async () => {
    mocks.tx.progressPhoto.findFirst.mockResolvedValue({ ...VIDEO, key: null });
    await svc().deletePhoto(actor('ADMIN'), 'photo-1');
    expect(mocks.storageDelete).toHaveBeenCalledTimes(1);
    expect(mocks.storageDelete).toHaveBeenCalledWith(VIDEO.posterKey);
  });

  it('does not call storage at all for a fully purged tombstone', async () => {
    mocks.tx.progressPhoto.findFirst.mockResolvedValue({ ...VIDEO, key: null, posterKey: null });
    await svc().deletePhoto(actor('ADMIN'), 'photo-1');
    expect(mocks.storageDelete).not.toHaveBeenCalled();
  });
});

describe('caption validation reaches the route contract', () => {
  it('rejects a caption-only body that is not a string', () => {
    expect(UpdatePhotoSchema.safeParse({ caption: 42 }).success).toBe(false);
    expect(UpdatePhotoSchema.safeParse({}).success).toBe(false);
    void BadRequestException; // the controller maps a parse failure to this
  });
});
