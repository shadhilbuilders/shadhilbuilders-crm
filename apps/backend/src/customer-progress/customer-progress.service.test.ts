// Customer-progress service guards (issue #7 slice 1, AC4).
//
// protects= the upload validation wall (MIME allowlist, size cap, empty
// file, phase-project binding, offset-carrying takenAt, cursor pagination
// arithmetic) - fails_when= any guard lets a bad payload through or a good
// payload gets a wrong page; no_claim= green does NOT exercise the real
// database (assertUnitAccess RLS behavior is owned by
// packages/database/test/progress-rls.test.ts) nor the storage adapters
// (their delete tests live beside them).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';

import {
  UploadPhotoSchema,
  UpdatePhotoSchema,
  CustomerProgressService,
  buildCaption,
  decodeCursor,
  encodeCursor,
  type UploadPhotoDto,
} from './customer-progress.service';

describe('UploadPhotoSchema', () => {
  const valid: Record<string, unknown> = {
    phaseId: 'cmw4n0zqn5yvpfhm3a5n3f9z',
    base64: Buffer.from('hello').toString('base64'),
    mimeType: 'image/jpeg',
    filename: 'site.jpg',
    takenAt: '2026-10-26T10:00:00+05:30',
  };

  it('protects= accepts a well-formed camera payload', () => {
    const parsed = UploadPhotoSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('protects= rejects HEIC with the slice-1 allowlist; fails_when= image/* widens it', () => {
    const parsed = UploadPhotoSchema.safeParse({ ...valid, mimeType: 'image/heic' });
    expect(parsed.success).toBe(false);
  });

  it('protects= rejects a takenAt without a UTC offset; fails_when= local time parses silently', () => {
    const noOffset = UploadPhotoSchema.safeParse({ ...valid, takenAt: '2026-10-26T10:00:00' });
    expect(noOffset.success).toBe(false);
  });

  it('protects= rejects an absurd datetime even with an offset', () => {
    const junk = UploadPhotoSchema.safeParse({ ...valid, takenAt: 'not-a-date+05:30' });
    expect(junk.success).toBe(false);
  });

  it('protects= rejects a filename over 180 chars', () => {
    const parsed = UploadPhotoSchema.safeParse({ ...valid, filename: 'x'.repeat(181) });
    expect(parsed.success).toBe(false);
  });

  it('protects= requires a real cuid2 phaseId; fails_when= slug-style ids pass', () => {
    const parsed = UploadPhotoSchema.safeParse({ ...valid, phaseId: 'unit-1' });
    expect(parsed.success).toBe(false);
  });
});

describe('buildCaption', () => {
  it('protects= "{phase} {month name} {year}" en-GB from UTC; fails_when= local-month drift', () => {
    // takenAt near a month boundary in IST vs UTC: 00:30 IST on the 1st is
    // still the previous day in UTC.
    const istJustAfterMidnight = new Date('2026-11-01T00:30:00+05:30');
    expect(buildCaption('Foundation', istJustAfterMidnight)).toBe('Foundation October 2026');
  });

  it('protects= phases without a name degrade to "Site photo"', () => {
    expect(buildCaption(null, new Date('2026-03-14T00:00:00Z'))).toBe('Site photo March 2026');
  });
});

describe('cursor codec', () => {
  it('protects= round-trips takenAt + id; fails_when= ordering ambiguity returns', () => {
    const takenAt = new Date('2026-10-26T10:00:00.123Z');
    const raw = encodeCursor(takenAt, 'cmw4n0zqn5yvpfhm3a5n3f9z');
    const decoded = decodeCursor(raw);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe('cmw4n0zqn5yvpfhm3a5n3f9z');
    expect(decoded!.takenAt.getTime()).toBe(takenAt.getTime());
  });

  it('protects= malformed cursors behave as absent (fresh page), never a 500', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('!not base64url!')).toBeNull();
    expect(decodeCursor(Buffer.from('{"id":null}', 'utf8').toString('base64url'))).toBeNull();
    // 2026-11-07: right SHAPE but an unparseable date. This used to decode to
    // an Invalid Date and reach Prisma, which throws
    // PrismaClientValidationError -> a 500 on a GET that must degrade to page
    // one. The two assertions above only covered structural failure.
    expect(
      decodeCursor(Buffer.from('{"takenAt":"not-a-date","id":"x"}', 'utf8').toString('base64url')),
    ).toBeNull();
    expect(
      decodeCursor(Buffer.from('{"takenAt":"2026-13-45T99:99:99Z","id":"x"}', 'utf8').toString('base64url')),
    ).toBeNull();
    // A VALID date still decodes (guard is not over-eager).
    const ok = decodeCursor(
      Buffer.from('{"takenAt":"2026-11-07T10:00:00.000Z","id":"abc"}', 'utf8').toString('base64url'),
    );
    expect(ok?.id).toBe('abc');
    expect(ok?.takenAt.toISOString()).toBe('2026-11-07T10:00:00.000Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upload() - the type recorded must come from the BYTES (2026-11-06).
//
// The bug this pins: a phone's camera roll hands back JPEG bytes under a name
// like IMG_2676.PNG, so the browser's File.type said image/png. Storing that
// verbatim wrote rows whose `mimeType` contradicted their own bytes, and the
// browser (nosniff) refused to render them. upload() now sniffs first.
// ─────────────────────────────────────────────────────────────────────────────

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function makeUploadActor(): JwtPayload {
  return {
    sub: 'admin-1',
    email: 'admin@shadhilbuilders.in',
    role: 'ADMIN',
    organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

/** Stub Prisma whose transaction runs the callback against itself. */
function makeUploadService() {
  const save = vi.fn(async (_data: Buffer, meta: { mimeType: string; filename: string }) => ({
    key: `/org/abc/${meta.filename}`,
    mimeType: meta.mimeType,
    filename: meta.filename,
    size: 1,
  }));
  const client = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    unit: { findFirst: vi.fn().mockResolvedValue({ id: 'unit-1', unitNumber: 'A-101', phase: { projectId: 'proj-1' } }) },
    phase: { findFirst: vi.fn().mockResolvedValue({ name: 'Phase A' }) },
    progressPhoto: {
      create: vi.fn().mockResolvedValue({ id: 'photo-1', createdAt: new Date('2026-11-06T10:00:00Z') }),
      // 2026-11-08: upload() counts today's photos for the unit so the staff
      // notification fires once per unit per day, not once per photo.
      count: vi.fn().mockResolvedValue(0),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ name: 'Ravi' }) },
  };
  const prismaService = { $client: client } as never;
  const storage = { save, read: vi.fn(), delete: vi.fn(), publicUrl: vi.fn() } as never;
  const service = new CustomerProgressService(prismaService, storage);
  return { service, client, save };
}

/** Same service with a SiteUpdateNotifier injected as the 4th arg. */
function makeUploadServiceWithSiteNotifier(notifyNewPhoto: (n: unknown) => Promise<number>) {
  const built = makeUploadService();
  const siteUpdateNotifier = { notifyNewPhoto: vi.fn(notifyNewPhoto) };
  const service = new CustomerProgressService(
    { $client: built.client } as never,
    { save: built.save, read: vi.fn(), delete: vi.fn(), publicUrl: vi.fn() } as never,
    undefined,
    siteUpdateNotifier as never,
  );
  return { ...built, service, siteUpdateNotifier };
}

const UPLOAD_DTO = {
  phaseId: 'cmw4n0zqn5yvpfhm3a5n3f9z',
  base64: '',
  mimeType: 'image/png',
  filename: 'IMG_2676.PNG',
  takenAt: '2026-11-06T10:00:00Z',
} satisfies UploadPhotoDto;

describe('upload() - the stored MIME comes from the bytes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records image/jpeg when PNG was declared but the bytes are JPEG', async () => {
    const { service, client, save } = makeUploadService();
    const dto = { ...UPLOAD_DTO, base64: JPEG_BYTES.toString('base64') };

    const result = await service.upload(makeUploadActor(), 'unit-1', dto);

    // The row, the response, and the stored object all agree with the BYTES.
    expect(result.mimeType).toBe('image/jpeg');
    expect(client.progressPhoto.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mimeType: 'image/jpeg' }) }),
    );
    expect(save.mock.calls[0]![1]).toMatchObject({ mimeType: 'image/jpeg' });
  });

  it('keeps the declared type when it matches the bytes', async () => {
    const { service } = makeUploadService();
    const dto: UploadPhotoDto = { ...UPLOAD_DTO, mimeType: 'image/png', base64: PNG_BYTES.toString('base64') };

    const result = await service.upload(makeUploadActor(), 'unit-1', dto);

    expect(result.mimeType).toBe('image/png');
  });

  it('rejects an unidentifiable buffer instead of storing it', async () => {
    const { service, save } = makeUploadService();
    const dto = { ...UPLOAD_DTO, base64: Buffer.from('definitely not an image').toString('base64') };

    await expect(service.upload(makeUploadActor(), 'unit-1', dto)).rejects.toThrow(/Unrecognised image format/);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects HEIC with an actionable message even when declared as jpeg', async () => {
    const { service, save } = makeUploadService();
    const heic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypheic', 'binary'),
    ]);
    const dto: UploadPhotoDto = { ...UPLOAD_DTO, mimeType: 'image/jpeg', base64: heic.toString('base64') };

    await expect(service.upload(makeUploadActor(), 'unit-1', dto)).rejects.toThrow(/HEIC.*Most Compatible/);
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a non-photo format the sniffer CAN identify (e.g. PDF)', async () => {
    const { service, save } = makeUploadService();
    const dto = { ...UPLOAD_DTO, base64: Buffer.from('%PDF-1.7\n').toString('base64') };

    await expect(service.upload(makeUploadActor(), 'unit-1', dto)).rejects.toThrow(/Unsupported image type: application\/pdf/);
    expect(save).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upload() - the buyer notification never touches the upload result (D8).
//
// The photo row has already committed when the notifier runs. A push failure -
// a buyer's phone gone, FCM down, a throw from anywhere inside the notifier -
// must not turn the site engineer's 201 into an error, and must not trip the
// blob-compensation delete that handles a FAILED row write.
// ─────────────────────────────────────────────────────────────────────────────

describe('upload() - PortalNotifier is best effort (D8)', () => {
  beforeEach(() => vi.clearAllMocks());

  /** Same service, with an optional notifier injected as the 3rd arg. */
  function withNotifier(notifyNewPhoto: (n: unknown) => Promise<number>) {
    const built = makeUploadService();
    const notifier = { notifyNewPhoto: vi.fn(notifyNewPhoto) };
    const service = new CustomerProgressService(
      { $client: built.client } as never,
      { save: built.save, read: vi.fn(), delete: vi.fn(), publicUrl: vi.fn() } as never,
      notifier as never,
    );
    return { ...built, service, notifier };
  }

  it('protects= the upload resolves even when the notifier throws', async () => {
    const { service, notifier } = withNotifier(async () => {
      throw new Error('push is down');
    });
    const dto = { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') };

    const result = await service.upload(makeUploadActor(), 'unit-1', dto);

    expect(result.id).toBe('photo-1');
    expect(notifier.notifyNewPhoto).toHaveBeenCalledTimes(1);
  });

  it('fails_when= a notifier fault trips the blob-compensation delete', async () => {
    const built = makeUploadService();
    const storageDelete = vi.fn();
    const svc = new CustomerProgressService(
      { $client: built.client } as never,
      { save: built.save, read: vi.fn(), delete: storageDelete, publicUrl: vi.fn() } as never,
      {
        notifyNewPhoto: vi.fn(async () => {
          throw new Error('push is down');
        }),
      } as never,
    );

    await svc.upload(makeUploadActor(), 'unit-1', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') });

    // The row committed, so the bytes must stay.
    expect(storageDelete).not.toHaveBeenCalled();
  });

  it('passes the committed photo + unit context to the notifier', async () => {
    const { service, notifier } = withNotifier(async () => 1);

    await service.upload(makeUploadActor(), 'unit-1', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') });

    expect(notifier.notifyNewPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        unitId: 'unit-1',
        unitNumber: 'A-101',
        photoId: 'photo-1',
      }),
    );
  });

  it('does not notify when the upload itself fails (no row, no push)', async () => {
    const { service, client, notifier } = withNotifier(async () => 1);
    client.progressPhoto.create.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.upload(makeUploadActor(), 'unit-1', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') }),
    ).rejects.toThrow(/db down/);

    expect(notifier.notifyNewPhoto).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upload() - the engineer's note travels with the photo (2026-11-08).
//
// The caption used to be generated AFTER the fact ("Phase A November 2026"),
// and a client that sent one had it silently ignored. That is why the capture
// flow could not put the engineer's sentence on the record without a second
// visit to a pencil icon.
// ─────────────────────────────────────────────────────────────────────────────

describe('UploadPhotoSchema - caption and stage', () => {
  const valid = {
    phaseId: 'cmw4n0zqn5yvpfhm3a5n3f9z',
    base64: 'QUJD',
    mimeType: 'image/jpeg',
    filename: 'site.jpg',
    takenAt: '2026-11-06T10:00:00+05:30',
  };

  it('accepts a supplied caption and trims it', () => {
    const parsed = UploadPhotoSchema.safeParse({ ...valid, caption: '  Plinth poured  ' });
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.caption : null).toBe('Plinth poured');
  });

  it('accepts an omitted caption, which keeps the generated fallback', () => {
    expect(UploadPhotoSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an empty and a whitespace-only caption', () => {
    expect(UploadPhotoSchema.safeParse({ ...valid, caption: '' }).success).toBe(false);
    expect(UploadPhotoSchema.safeParse({ ...valid, caption: '   ' }).success).toBe(false);
  });

  it('rejects 201 characters and accepts exactly 200', () => {
    expect(UploadPhotoSchema.safeParse({ ...valid, caption: 'x'.repeat(201) }).success).toBe(false);
    expect(UploadPhotoSchema.safeParse({ ...valid, caption: 'x'.repeat(200) }).success).toBe(true);
  });

  it('accepts every construction stage and rejects an unknown string', () => {
    for (const stage of [
      'NOT_STARTED',
      'FOUNDATION',
      'STRUCTURE',
      'MASONRY',
      'PLASTERING',
      'WATERPROOFING',
      'FLOORING',
      'FINISHING',
      'READY',
    ]) {
      expect(UploadPhotoSchema.safeParse({ ...valid, stage }).success).toBe(true);
    }
    expect(UploadPhotoSchema.safeParse({ ...valid, stage: 'ROOFING' }).success).toBe(false);
  });
});

describe('upload() - the caption', () => {
  beforeEach(() => vi.clearAllMocks());

  it('protects= a supplied caption is persisted and returned verbatim', async () => {
    const { service, client } = makeUploadService();
    const result = await service.upload(makeUploadActor(), 'unit-1', {
      ...UPLOAD_DTO,
      base64: PNG_BYTES.toString('base64'),
      caption: 'Plinth poured, curing until Friday',
    });

    expect(client.progressPhoto.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ caption: 'Plinth poured, curing until Friday' }),
      }),
    );
    expect(result.caption).toBe('Plinth poured, curing until Friday');
  });

  it('fails_when= an omitted caption stops producing the generated one', async () => {
    // Old clients (and an engineer who types nothing) must keep today's exact
    // behaviour: buildCaption(phaseName, takenAt) -> "Phase A November 2026".
    const { service, client } = makeUploadService();
    const result = await service.upload(makeUploadActor(), 'unit-1', {
      ...UPLOAD_DTO,
      base64: PNG_BYTES.toString('base64'),
    });

    expect(result.caption).toBe('Phase A November 2026');
    expect(client.progressPhoto.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ caption: 'Phase A November 2026' }),
      }),
    );
  });

  it('records the stage with the photo, and null when none was sent', async () => {
    const { service, client } = makeUploadService();
    await service.upload(makeUploadActor(), 'unit-1', {
      ...UPLOAD_DTO,
      base64: PNG_BYTES.toString('base64'),
      stage: 'STRUCTURE',
    });
    expect(client.progressPhoto.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stage: 'STRUCTURE' }) }),
    );

    vi.clearAllMocks();
    const second = makeUploadService();
    await second.service.upload(makeUploadActor(), 'unit-1', {
      ...UPLOAD_DTO,
      base64: PNG_BYTES.toString('base64'),
    });
    expect(second.client.progressPhoto.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stage: null }) }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upload() - the staff notification (2026-11-08).
//
// One notification per unit per DAY, not one per photo: an engineer shooting six
// angles of one villa must not produce six pings. And a notifier fault must never
// reach the engineer, nor trip the blob compensation.
// ─────────────────────────────────────────────────────────────────────────────

describe('upload() - SiteUpdateNotifier', () => {
  beforeEach(() => vi.clearAllMocks());

  it('protects= the first photo of the day notifies, and a later one does not', async () => {
    const first = makeUploadServiceWithSiteNotifier(async () => 1);
    await first.service.upload(makeUploadActor(), 'unit-1', {
      ...UPLOAD_DTO,
      base64: PNG_BYTES.toString('base64'),
    });
    expect(first.siteUpdateNotifier.notifyNewPhoto).toHaveBeenCalledTimes(1);

    // Same unit, same day: the count is no longer zero.
    const second = makeUploadServiceWithSiteNotifier(async () => 1);
    second.client.progressPhoto.count.mockResolvedValue(3);
    await second.service.upload(makeUploadActor(), 'unit-1', {
      ...UPLOAD_DTO,
      base64: PNG_BYTES.toString('base64'),
    });
    expect(second.siteUpdateNotifier.notifyNewPhoto).not.toHaveBeenCalled();
  });

  it('protects= the notice carries the unit, captions and the uploader identity', async () => {
    const { service, siteUpdateNotifier } = makeUploadServiceWithSiteNotifier(async () => 1);
    await service.upload(makeUploadActor(), 'unit-1', {
      ...UPLOAD_DTO,
      base64: PNG_BYTES.toString('base64'),
      caption: 'Slab poured',
    });

    expect(siteUpdateNotifier.notifyNewPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        unitId: 'unit-1',
        unitNumber: 'A-101',
        photoId: 'photo-1',
        caption: 'Slab poured',
        uploaderId: 'admin-1',
        uploaderName: 'Ravi',
      }),
    );
  });

  it('fails_when= a notifier fault fails the upload or deletes the committed blob', async () => {
    const built = makeUploadService();
    const storageDelete = vi.fn();
    const svc = new CustomerProgressService(
      { $client: built.client } as never,
      { save: built.save, read: vi.fn(), delete: storageDelete, publicUrl: vi.fn() } as never,
      undefined,
      {
        notifyNewPhoto: vi.fn(async () => {
          throw new Error('notifications down');
        }),
      } as never,
    );

    const result = await svc.upload(makeUploadActor(), 'unit-1', {
      ...UPLOAD_DTO,
      base64: PNG_BYTES.toString('base64'),
    });

    expect(result.id).toBe('photo-1');
    expect(storageDelete).not.toHaveBeenCalled();
  });
});

describe('UpdatePhotoSchema - partial writes (stage and caption are independent)', () => {
  it('accepts a caption-only correction', () => {
    expect(UpdatePhotoSchema.safeParse({ caption: 'Corrected' }).success).toBe(true);
  });

  it('accepts a stage-only correction (the case that used to 400)', () => {
    expect(UpdatePhotoSchema.safeParse({ stage: 'READY' }).success).toBe(true);
  });

  it('accepts both together', () => {
    expect(UpdatePhotoSchema.safeParse({ caption: 'Corrected', stage: 'READY' }).success).toBe(true);
  });

  it('rejects neither, so a no-op PATCH is a caller bug, not a silent touch', () => {
    expect(UpdatePhotoSchema.safeParse({}).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertUnitAccess() - the messaging wall in front of RLS (slice-1 AC4).
//
// The spec demands "unit-not-in-actor's-project → 403/404" and the module
// disclaimer claimed the DB test owned it. progress-rls.test.ts proves the
// POLICY denies rows; it does not prove the SERVICE returns the right status
// code, and a silent RLS empty set is indistinguishable from "no photos" to a
// caller. These pin the four branches directly.
// ─────────────────────────────────────────────────────────────────────────────

function makeAccessService(over: {
  unit?: unknown;
  member?: unknown;
}) {
  const built = makeUploadService();
  if ('unit' in over) built.client.unit.findFirst.mockResolvedValue(over.unit);
  const projectTeamFindFirst = vi.fn().mockResolvedValue(over.member ?? null);
  Object.assign(built.client, { projectTeam: { findFirst: projectTeamFindFirst } });
  return { ...built, projectTeamFindFirst };
}

const STAFF_ROLES = ['ENGINEER', 'MANAGER', 'SALES_EXEC', 'TELECALLER'] as const;
const actorAs = (role: JwtPayload['role']): JwtPayload => ({ ...makeUploadActor(), role });

describe('assertUnitAccess - the service returns a typed status, not a silent empty set', () => {
  // The actor's sub is 'admin-1' for every role here, so an ENGINEER passes the
  // 2026-11-10 assignment check only when the unit is assigned to that sub.
  const UNIT = {
    id: 'unit-1',
    unitNumber: 'A-101',
    assignedEngineerId: 'admin-1',
    phase: { projectId: 'proj-1' },
  };

  it('protects= an ENGINEER cannot act on a villa assigned to someone else (403)', async () => {
    const { service } = makeAccessService({
      unit: { ...UNIT, assignedEngineerId: 'someone-else' },
      member: { projectId: 'proj-1' },
    });
    await expect(
      service.upload(actorAs('ENGINEER'), 'unit-1', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('protects= an ENGINEER cannot act on an UNASSIGNED villa even on their own team (403)', async () => {
    const { service } = makeAccessService({
      unit: { ...UNIT, assignedEngineerId: null },
      member: { projectId: 'proj-1' },
    });
    await expect(
      service.upload(actorAs('ENGINEER'), 'unit-1', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails_when= the assignment check leaks onto MANAGER (they review via team membership)', async () => {
    const { service } = makeAccessService({
      unit: { ...UNIT, assignedEngineerId: null },
      member: { projectId: 'proj-1' },
    });
    await expect(
      service.upload(actorAs('MANAGER'), 'unit-1', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') }),
    ).resolves.toBeDefined();
  });

  it('ADMIN reaches any org unit without a project-team lookup', async () => {
    const { service, projectTeamFindFirst } = makeAccessService({ unit: UNIT });
    await expect(
      service.upload(actorAs('ADMIN'), 'unit-1', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') }),
    ).resolves.toBeDefined();
    expect(projectTeamFindFirst).not.toHaveBeenCalled();
  });

  it('protects= a project member may upload (one row per staff role)', async () => {
    for (const role of STAFF_ROLES) {
      const { service } = makeAccessService({ unit: UNIT, member: { projectId: 'proj-1' } });
      await expect(
        service.upload(actorAs(role), 'unit-1', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') }),
      ).resolves.toBeDefined();
    }
  });

  // AC4 exact: "unit-not-in-actor's-project → 403".
  it('fails_when= a staff role outside the project gets through (403)', async () => {
    for (const role of STAFF_ROLES) {
      const { service } = makeAccessService({ unit: UNIT, member: null });
      await expect(
        service.upload(actorAs(role), 'unit-1', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('fails_when= an unknown unit reports 403 instead of 404 (404 never confirms a foreign unit)', async () => {
    const { service } = makeAccessService({ unit: null });
    await expect(
      service.upload(actorAs('ENGINEER'), 'unit-x', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fails_when= the unit lookup is not org-scoped (cross-org read)', async () => {
    const { service, client } = makeAccessService({ unit: UNIT, member: { projectId: 'proj-1' } });
    await service.upload(actorAs('ENGINEER'), 'unit-1', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') });
    expect(client.unit.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'ceid01lpfe1esm8jwsxid41k28' }),
      }),
    );
  });

  it('fails_when= the membership lookup ignores soft-deleted teams', async () => {
    const { service, projectTeamFindFirst } = makeAccessService({ unit: UNIT, member: null });
    await expect(
      service.upload(actorAs('ENGINEER'), 'unit-1', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(projectTeamFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          team: expect.objectContaining({ deletedAt: null }),
        }),
      }),
    );
  });

  // A role with no business uploading at all must not fall through to the
  // membership arm and must not be treated as admin. A buyer's RLS context
  // sees no units, so the unit read resolves null and the answer is 404 - the
  // same shape a foreign unit takes. What matters is that it is NOT 201.
  it('fails_when= a CUSTOMER can reach the staff upload route', async () => {
    const { service } = makeAccessService({ unit: null, member: { projectId: 'proj-1' } });
    await expect(
      service.upload(actorAs('CUSTOMER'), 'unit-1', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fails_when= a CUSTOMER with a visible unit is granted by the membership arm', async () => {
    // Even if the unit row were somehow visible, CUSTOMER is not in the
    // staff-role list, so it must fall through to 403 - never inherit the
    // membership path that ENGINEER/MANAGER/SALES_EXEC/TELECALLER use.
    const { service } = makeAccessService({ unit: UNIT, member: { projectId: 'proj-1' } });
    await expect(
      service.upload(actorAs('CUSTOMER'), 'unit-1', { ...UPLOAD_DTO, base64: PNG_BYTES.toString('base64') }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setPhotoLead() - the target must be STAFFED on the project (2026-11-07).
//
// The bug this pins: the grant only checked "project exists" + "user exists in
// this org", so an admin could grant project-wide photo authority to someone
// on no team that touches the site. Nothing visibly broke because no photo
// edit/delete route exists yet - the grant just sat there, waiting to matter.
// ─────────────────────────────────────────────────────────────────────────────

function makePhotoLeadService(opts: { staffed: boolean }) {
  const projectTeamFindFirst = vi.fn().mockResolvedValue(opts.staffed ? { projectId: 'proj-1' } : null);
  const projectStaffRoleUpsert = vi.fn().mockResolvedValue({});
  const projectStaffRoleDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const auditCreate = vi.fn().mockResolvedValue({});
  const client = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    project: { findFirst: vi.fn().mockResolvedValue({ id: 'proj-1' }) },
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'eng-1' }) },
    projectTeam: { findFirst: projectTeamFindFirst },
    projectStaffRole: {
      upsert: projectStaffRoleUpsert,
      deleteMany: projectStaffRoleDeleteMany,
    },
    auditLog: { create: auditCreate },
  };
  const prismaService = { $client: client } as never;
  const storage = { save: vi.fn(), read: vi.fn(), delete: vi.fn(), publicUrl: vi.fn() } as never;
  return {
    service: new CustomerProgressService(prismaService, storage),
    projectTeamFindFirst,
    projectStaffRoleUpsert,
    projectStaffRoleDeleteMany,
    auditCreate,
  };
}

describe('setPhotoLead() - staffing gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GRANT is refused when the target is on no team linked to the project', async () => {
    const { service, projectStaffRoleUpsert, auditCreate } = makePhotoLeadService({ staffed: false });

    await expect(
      service.setPhotoLead(makeUploadActor(), 'proj-1', 'eng-1', { photoLead: true }),
    ).rejects.toThrow(/not staffed on this project/);

    // Nothing written, nothing logged - a refused grant must not look applied.
    expect(projectStaffRoleUpsert).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('GRANT succeeds when the target is staffed on the project', async () => {
    const { service, projectStaffRoleUpsert, auditCreate } = makePhotoLeadService({ staffed: true });

    const res = await service.setPhotoLead(makeUploadActor(), 'proj-1', 'eng-1', { photoLead: true });

    expect(res).toEqual({ userId: 'eng-1', projectId: 'proj-1', photoLead: true });
    expect(projectStaffRoleUpsert).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'progress.photo_lead_granted' }),
      }),
    );
  });

  it('REVOKE still works for someone no longer staffed (stale grant must be clearable)', async () => {
    const { service, projectStaffRoleDeleteMany, auditCreate } = makePhotoLeadService({ staffed: false });

    const res = await service.setPhotoLead(makeUploadActor(), 'proj-1', 'eng-1', { photoLead: false });

    expect(res.photoLead).toBe(false);
    // The staffing predicate is a GRANT rule only: removing someone from a
    // team leaves their ProjectStaffRole behind, and a revoke that demanded
    // staffing could never clear it.
    expect(projectStaffRoleDeleteMany).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'progress.photo_lead_revoked' }),
      }),
    );
  });

  it('non-admin is refused before any project/user lookup', async () => {
    const { service, projectTeamFindFirst } = makePhotoLeadService({ staffed: true });
    const managerActor: JwtPayload = { ...makeUploadActor(), role: 'MANAGER' };

    await expect(
      service.setPhotoLead(managerActor, 'proj-1', 'eng-1', { photoLead: true }),
    ).rejects.toThrow(/Only ADMIN or OWNER/);
    expect(projectTeamFindFirst).not.toHaveBeenCalled();
  });
});
