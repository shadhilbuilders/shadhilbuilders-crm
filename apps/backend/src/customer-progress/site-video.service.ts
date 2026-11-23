// Site update video: grant, inline upload, record, cancel (plan sections 5, 8).
//
// The shape of the write path: the browser uploads the bytes (straight to the
// CDN with a short-lived signature, or through `inlineUpload` on local disk),
// then `record` proves what landed and only then creates the row. Nothing the
// client says about size, type or privacy is believed; the storage layer is
// asked. The row, the audit entry and both ledger charges commit in ONE
// transaction, so a cap failure or a save failure leaves nothing half-done.
import { basename } from 'node:path';

import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { withRlsContext, rlsContextFrom } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';

import { CodedException } from '../common/errors/coded-exception';
import { PrismaService } from '../prisma/prisma.module';
import { keyInUploadFolder } from '../storage/media-key-scope';
import type { StorageProvider, UploadAuth } from '../storage/storage.provider';
import { MAX_VIDEO_BYTES } from '../storage/storage.limits';
import { sniffMime } from '../storage/sniff-mime';
import { STORAGE_PROVIDER } from '../storage/storage.tokens';
import { buildCaption, CustomerProgressService } from './customer-progress.service';
import { readTimelinePage, type TimelinePhotoDto } from './progress-photo.mapper';
import { SITE_VIDEO_CONFIG, type SiteVideoConfig } from './site-video.config';
import { siteVideoError } from './site-video.errors';
import { assertHeadroom, chargeLedgers } from './site-video-ledger';
import { SiteVideoRateLimiter } from './site-video-rate-limiter';
import {
  MAX_VIDEO_DURATION_MS,
  type InlineUploadDto,
  type RecordVideoDto,
} from './site-video.schemas';
import { issueUploadId, verifyUploadId } from './site-video-upload-id';
import { POSTER_MAX_BYTES, guardStorage, verifyClip, verifyPoster } from './site-video-verify';

const SLOT_FILE = { clip: 'clip.mp4', poster: 'poster.jpg' } as const;
const POSTER_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SLOT_MIME = { clip: 'video/mp4', poster: 'image/jpeg' } as const;

export interface UploadGrant {
  uploadId: string;
  auth: UploadAuth;
  maxDurationMs: number;
  maxBytes: number;
}

export interface RecordResult {
  photo: TimelinePhotoDto;
  /** True when this exact take was already saved and the existing row is returned. */
  replayed: boolean;
}

/** Serialise record/cancel/discard of ONE upload id for the rest of this transaction. */
async function lockUpload(
  tx: { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> },
  uploadId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`sitevideo:${uploadId}`}))`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

@Injectable()
export class SiteVideoService {
  private readonly logger = new Logger(SiteVideoService.name);

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(forwardRef(() => STORAGE_PROVIDER)) private readonly storage: StorageProvider,
    @Inject(CustomerProgressService) private readonly progress: CustomerProgressService,
    @Inject(SiteVideoRateLimiter) private readonly limiter: SiteVideoRateLimiter,
    @Inject(SITE_VIDEO_CONFIG) private readonly config: SiteVideoConfig,
  ) {}

  private get client() {
    return this.prismaService.$client;
  }

  private requireEnabled(): void {
    if (!this.config.enabled) throw siteVideoError('VIDEO_CAPTURE_DISABLED');
  }

  private caps() {
    return {
      orgCapBytes: this.config.orgCapBytes,
      projectCapBytes: this.config.projectCapBytes,
    };
  }

  private requireIssuedUploadId(actor: JwtPayload, unitId: string, uploadId: string): void {
    const ok = verifyUploadId(uploadId, {
      organizationId: actor.organizationId,
      unitId,
      userId: actor.sub,
    });
    if (!ok) throw siteVideoError('VIDEO_UPLOAD_INVALID');
  }

  /** POST /units/:unitId/videos/upload-auth */
  async uploadAuth(actor: JwtPayload, unitId: string): Promise<UploadGrant> {
    this.requireEnabled();
    const { projectId } = await this.progress.assertUnitAccess(actor, unitId);
    await this.limiter.consume({
      organizationId: actor.organizationId,
      userId: actor.sub,
      projectId,
    });
    await withRlsContext(this.client, rlsContextFrom(actor), (tx) =>
      assertHeadroom(
        tx,
        { organizationId: actor.organizationId, projectId },
        MAX_VIDEO_BYTES,
        this.caps(),
      ),
    );

    const uploadId = issueUploadId({
      organizationId: actor.organizationId,
      unitId,
      userId: actor.sub,
    });
    if (this.storage.createUploadAuth === undefined) throw siteVideoError('STORAGE_UNAVAILABLE');
    const auth = this.storage.createUploadAuth({
      organizationId: actor.organizationId,
      uploadId,
      maxBytes: MAX_VIDEO_BYTES,
    });
    return { uploadId, auth, maxDurationMs: MAX_VIDEO_DURATION_MS, maxBytes: MAX_VIDEO_BYTES };
  }

  /** POST /units/:unitId/videos/uploads/:uploadId - local-disk transport only. */
  async inlineUpload(
    actor: JwtPayload,
    unitId: string,
    uploadId: string,
    dto: InlineUploadDto,
  ): Promise<{ key: string; size: number }> {
    this.requireEnabled();
    await this.progress.assertUnitAccess(actor, unitId);
    this.requireIssuedUploadId(actor, unitId, uploadId);

    const grant = this.storage.createUploadAuth?.({
      organizationId: actor.organizationId,
      uploadId,
      maxBytes: MAX_VIDEO_BYTES,
    });
    if (grant?.transport !== 'inline') throw siteVideoError('VIDEO_INLINE_UNSUPPORTED');

    // A recorded take's bytes are frozen: re-posting to the same fixed filename
    // would swap the content under a row whose size the ledger already charged.
    const recorded = await withRlsContext(this.client, rlsContextFrom(actor), (tx) =>
      tx.progressPhoto.findFirst({
        where: { organizationId: actor.organizationId, unitId, uploadId },
        select: { id: true },
      }),
    );
    if (recorded !== null) throw siteVideoError('VIDEO_UPLOAD_ID_REUSED');

    const bytes = Buffer.from(dto.base64, 'base64');
    if (bytes.length === 0) throw siteVideoError('VIDEO_SIZE_MISMATCH');
    this.assertSlotContent(dto.slot, bytes);
    if (dto.slot === 'clip' && bytes.length > MAX_VIDEO_BYTES) {
      throw siteVideoError('VIDEO_TOO_LARGE', { maxBytes: MAX_VIDEO_BYTES });
    }
    if (dto.slot === 'poster' && bytes.length > POSTER_MAX_BYTES) {
      throw siteVideoError('VIDEO_POSTER_INVALID');
    }
    const stored = await guardStorage(() =>
      this.storage.save(bytes, {
        organizationId: actor.organizationId,
        mimeType: SLOT_MIME[dto.slot],
        filename: SLOT_FILE[dto.slot],
        uploadId,
      }),
    );
    return { key: stored.key, size: stored.size };
  }

  /** POST /units/:unitId/videos */
  async record(actor: JwtPayload, unitId: string, dto: RecordVideoDto): Promise<RecordResult> {
    this.requireEnabled();
    const { projectId } = await this.progress.assertUnitAccess(actor, unitId);
    this.requireIssuedUploadId(actor, unitId, dto.uploadId);
    this.assertKeysInFolder(actor.organizationId, dto);
    if (dto.durationMs > MAX_VIDEO_DURATION_MS) {
      throw siteVideoError('VIDEO_TOO_LONG', { maxMs: MAX_VIDEO_DURATION_MS });
    }

    const replay = await this.findExisting(actor, unitId, dto);
    if (replay !== null) return replay;

    const phase = await this.resolvePhase(actor, projectId, dto.phaseId);
    const size = await this.verifyUpload(actor, unitId, dto);
    const takenAt = new Date(dto.takenAt);
    const caption = dto.caption ?? buildCaption(phase.name, takenAt);

    try {
      const photo = await this.insertRow(actor, unitId, projectId, dto, caption, takenAt, size);
      return { photo, replayed: false };
    } catch (err) {
      return this.settleInsertFailure(err, actor, unitId, dto);
    }
  }

  /** DELETE /units/:unitId/videos/pending/:uploadId - idempotent, folder-scoped. */
  async cancel(
    actor: JwtPayload,
    unitId: string,
    uploadId: string,
  ): Promise<{ cancelled: boolean }> {
    this.requireEnabled();
    await this.progress.assertUnitAccess(actor, unitId);
    this.requireIssuedUploadId(actor, unitId, uploadId);

    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      // Same lock `record` takes: a cancel and a record of one take are serialised,
      // so a row can never be committed over a folder that is being deleted.
      await lockUpload(tx, uploadId);
      const recorded = await tx.progressPhoto.findFirst({
        where: { organizationId: actor.organizationId, unitId, uploadId },
        select: { id: true },
      });
      // A recorded take is a real row now: its bytes are the row's, not ours to cancel.
      if (recorded !== null) return { cancelled: false };
      await this.storage.deleteUploadFolder(actor.organizationId, uploadId);
      return { cancelled: true };
    });
  }

  /** Content check at write time, the same rule `record` applies when it verifies. */
  private assertSlotContent(slot: 'clip' | 'poster', bytes: Buffer): void {
    const sniffed = sniffMime(bytes.subarray(0, 64));
    if (slot === 'clip' && sniffed !== 'video/mp4') {
      throw siteVideoError('VIDEO_CONTAINER_UNSUPPORTED', { detected: sniffed });
    }
    if (slot === 'poster' && !POSTER_MIMES.has(sniffed ?? '')) {
      throw siteVideoError('VIDEO_POSTER_INVALID');
    }
  }

  // ── record helpers ──────────────────────────────────────────────────────

  private assertKeysInFolder(organizationId: string, dto: RecordVideoDto): void {
    const inFolder = (key: string) => keyInUploadFolder(key, organizationId, dto.uploadId);
    if (!inFolder(dto.key) || !inFolder(dto.posterKey) || dto.key === dto.posterKey) {
      throw siteVideoError('VIDEO_UPLOAD_INVALID');
    }
  }

  private async resolvePhase(actor: JwtPayload, projectId: string, phaseId: string) {
    const phase = await withRlsContext(this.client, rlsContextFrom(actor), (tx) =>
      tx.phase.findFirst({
        where: { id: phaseId, projectId, organizationId: actor.organizationId },
        select: { name: true },
      }),
    );
    if (phase === null) throw siteVideoError('VIDEO_UPLOAD_INVALID', { field: 'phaseId' });
    return phase;
  }

  /** Same take already saved: 200 with the existing row. Different keys: 409. */
  private async findExisting(
    actor: JwtPayload,
    unitId: string,
    dto: RecordVideoDto,
  ): Promise<RecordResult | null> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const found = await tx.progressPhoto.findFirst({
        where: { organizationId: actor.organizationId, unitId, uploadId: dto.uploadId },
        select: { id: true, key: true, posterKey: true },
      });
      if (found === null) return null;
      // Deletes nothing on a conflict: those blobs may belong to the row being retried.
      if (found.key !== dto.key || found.posterKey !== dto.posterKey) {
        throw siteVideoError('VIDEO_UPLOAD_ID_REUSED');
      }
      const page = await readTimelinePage(tx, {
        unitId,
        organizationId: actor.organizationId,
        cursorRaw: undefined,
        onlyPhotoId: found.id,
        scope: { viewer: { userId: actor.sub, role: actor.role }, leadsProject: false },
      });
      const photo = page.photos[0];
      return photo === undefined ? null : { photo, replayed: true };
    });
  }

  /** Verify both objects. A CLIENT-caused refusal also discards the upload folder. */
  private async verifyUpload(
    actor: JwtPayload,
    unitId: string,
    dto: RecordVideoDto,
  ): Promise<number> {
    try {
      const clip = await verifyClip(this.storage, dto.key, dto.sizeBytes);
      await verifyPoster(this.storage, dto.posterKey);
      return clip.size;
    } catch (err) {
      if (err instanceof CodedException && this.isClientFault(err)) {
        await this.discardUnrecorded(actor, unitId, dto.uploadId);
      }
      throw err;
    }
  }

  /** Delete the folder only if no row claims it (a racing twin may have recorded it). */
  private async discardUnrecorded(
    actor: JwtPayload,
    unitId: string,
    uploadId: string,
  ): Promise<void> {
    await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      await lockUpload(tx, uploadId);
      const row = await tx.progressPhoto.findFirst({
        where: { organizationId: actor.organizationId, unitId, uploadId },
        select: { id: true },
      });
      if (row === null) await this.storage.deleteUploadFolder(actor.organizationId, uploadId);
    });
  }

  /** Refusals that mean "this upload is bad", as opposed to "we could not check". */
  private isClientFault(err: CodedException): boolean {
    const code = (err.getResponse() as { code?: string }).code;
    return (
      code === 'VIDEO_NOT_PRIVATE' ||
      code === 'VIDEO_TOO_LARGE' ||
      code === 'VIDEO_CONTAINER_UNSUPPORTED' ||
      code === 'VIDEO_POSTER_INVALID' ||
      code === 'VIDEO_SIZE_MISMATCH'
    );
  }

  private async insertRow(
    actor: JwtPayload,
    unitId: string,
    projectId: string,
    dto: RecordVideoDto,
    caption: string,
    takenAt: Date,
    size: number,
  ): Promise<TimelinePhotoDto> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      await lockUpload(tx, dto.uploadId);
      // A cancel may have deleted the folder between verify and now.
      const stillThere = await guardStorage(() => this.storage.stat(dto.key));
      if (stillThere === null) throw siteVideoError('VIDEO_UPLOAD_NOT_FOUND');
      await chargeLedgers(
        tx,
        { organizationId: actor.organizationId, projectId },
        size,
        this.caps(),
      );
      const row = await tx.progressPhoto.create({
        data: {
          unitId,
          phaseId: dto.phaseId,
          organizationId: actor.organizationId,
          kind: 'VIDEO',
          key: dto.key,
          posterKey: dto.posterKey,
          mimeType: 'video/mp4',
          filename: basename(dto.key),
          caption,
          takenAt,
          stage: dto.stage ?? null,
          createdBy: actor.sub,
          sizeBytes: size,
          durationMs: dto.durationMs,
          batchId: dto.batchId,
          uploadId: dto.uploadId,
          hasAudio: dto.hasAudio,
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'progress.video_recorded',
          organizationId: actor.organizationId,
          entityType: 'ProgressPhoto',
          entityId: row.id,
          before: {},
          after: { key: dto.key, posterKey: dto.posterKey, sizeBytes: size, unitId },
          reason: `video recorded by ${actor.email} (${actor.role})`,
        },
      });
      const page = await readTimelinePage(tx, {
        unitId,
        organizationId: actor.organizationId,
        cursorRaw: undefined,
        onlyPhotoId: row.id,
        scope: { viewer: { userId: actor.sub, role: actor.role }, leadsProject: false },
      });
      const photo = page.photos[0];
      if (photo === undefined) throw new Error('recorded video row not readable back');
      return photo;
    });
  }

  /**
   * An insert that failed. A typed refusal (the cap) passes through. A unique
   * violation means another request recorded this take first: replay it. Anything
   * else is a retryable save failure, and deletes NOTHING - the retry reuses the
   * same blobs.
   */
  private async settleInsertFailure(
    err: unknown,
    actor: JwtPayload,
    unitId: string,
    dto: RecordVideoDto,
  ): Promise<RecordResult> {
    if (err instanceof CodedException) throw err;
    if (isUniqueViolation(err)) {
      const replay = await this.findExisting(actor, unitId, dto);
      if (replay !== null) return replay;
    }
    this.logger.error(
      `[site-video] record failed unit=${unitId} upload=${dto.uploadId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw siteVideoError('VIDEO_SAVE_FAILED');
  }
}
