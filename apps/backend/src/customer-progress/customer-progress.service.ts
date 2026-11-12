// Customer progress module (issue #7 slice 1): photo upload + staff preview
// timeline per unit.
//
// Scoping (per JWT): every read/write flows through withRlsContext; unit
// access = ProjectTeam/TeamMember membership OR team-manager of a linked
// team (RLS enforces the same shape as progress_photo_select_member), ADMIN
// org-wide (OWNER travels as ADMIN at the GUC layer). Non-members are
// service-403ed (RLS alone denies silently - permissive-by-absence looks
// like "no photos yet", which is why the service check is the messaging
// wall).
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { ConstructionStageSchema } from '@shadhil/api-types';
import { z } from 'zod';

import { isAdminClass } from '../users/roles';
import { STORAGE_PROVIDER } from '../storage/storage.tokens';
import type { StorageProvider } from '../storage/storage.provider';
import { MAX_UPLOAD_BYTES } from '../storage/storage.limits';
import { reconcileUploadMime } from '../storage/sniff-mime';
import { PrismaService } from '../prisma/prisma.module';
import { PortalNotifier } from '../customer-portal/portal-notifier.service';
import { SiteUpdateNotifier } from './site-update-notifier.service';
import { withRlsContext, rlsContextFrom, type PrismaClient, type RlsTx } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';

import {
  PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  mediaUrlFor,
  readTimelinePage,
  type TimelinePhotoDto,
  type TimelineResponseDto,
} from './progress-photo.mapper';

// ── DTOs ────────────────────────────────────────────────────────────────────

export const UploadPhotoSchema = z.object({
  phaseId: z.string().cuid2(),
  base64: z.string().min(1),
  // Slice-1 allowlist (spec): JPEG/PNG/WebP. HEIC is rejected with an
  // actionable message (iOS converter is a slice-2 rendering decision).
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  filename: z.string().min(1).max(180),
  // ISO 8601 WITH offset ("...Z" or "...+05:30"). A bare local datetime is
  // rejected: the timeline's ordering across devices depends on the offset.
  takenAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid datetime')
    .refine((s) => /(?:Z|[+-]\d{2}:?\d{2})$/.test(s.trim()), 'takenAt must carry a UTC offset'),
  clientDeviceHint: z.enum(['camera', 'gallery']).optional(),
  /**
   * The engineer's own note (2026-11-08). Optional FOREVER: a client that omits
   * it keeps the historical behaviour exactly (the server generates
   * `buildCaption(...)`), which is what every pre-existing client does and what
   * the flow must still do when the engineer types nothing.
   *
   * Trimmed, but NOT rejected when the trim empties it: an empty string is a
   * caller that passed "" rather than omitting the key, and turning that into a
   * 400 would make "no note" fail. `??` semantics apply - "" is falsy-ish for
   * our purposes only if we normalise here, so see `upload()`.
   */
  caption: z.string().trim().min(1).max(200).optional(),
  /** Construction stage recorded with this capture (2026-11-08). Optional. */
  stage: ConstructionStageSchema.optional(),
});
export type UploadPhotoDto = z.infer<typeof UploadPhotoSchema>;

export const SetPhotoLeadSchema = z.object({
  photoLead: z.boolean(),
});
export type SetPhotoLeadDto = z.infer<typeof SetPhotoLeadSchema>;

/**
 * Photo correction (slice 4, 2026-11-07; stage added 2026-11-08).
 *
 * Phase is not here: `phaseId` is a property of the unit, `takenAt` is evidence
 * of when the site work happened, and `unitId` would move a buyer's photo to
 * another home. Trimming is rejected rather than silently applied so a client
 * sending " Foundation " gets the caption it asked for, not a surprise.
 *
 * PARTIAL by design (2026-11-08): correcting a caption must never clear the
 * stage, and correcting a stage must never clear the caption. Both fields are
 * optional and at least one must be present - a stage-only correction used to
 * 400 because `caption` was required.
 */
export const UpdatePhotoSchema = z
  .object({
    caption: z
      .string()
      .trim()
      .min(1, 'caption cannot be empty')
      .max(200, 'caption is too long (max 200 characters)')
      .optional(),
    stage: ConstructionStageSchema.optional(),
  })
  .refine((v) => v.caption !== undefined || v.stage !== undefined, {
    message: 'send caption, stage, or both',
    path: ['caption'],
  });
export type UpdatePhotoDto = z.infer<typeof UpdatePhotoSchema>;

// Wire shapes + PAGE_SIZE + cursor codec live in progress-photo.mapper.ts so the
// buyer portal reads through the identical code path (issue #8). Re-exported
// here so existing importers (controller, tests) are unaffected.
export { PAGE_SIZE, decodeCursor, encodeCursor };
export type { TimelinePhotoDto, TimelineResponseDto };

// ── Service ─────────────────────────────────────────────────────────────────

/** Caption: "{phase.name} {en-GB month name} {year}" from takenAt (UTC). */
export function buildCaption(phaseName: string | null, takenAt: Date): string {
  const month = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(
    takenAt,
  );
  const year = new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: 'UTC' }).format(
    takenAt,
  );
  return `${phaseName ?? 'Site photo'} ${month} ${year}`;
}

@Injectable()
export class CustomerProgressService {
  private readonly logger = new Logger(CustomerProgressService.name);

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(forwardRef(() => STORAGE_PROVIDER)) private readonly storage: StorageProvider,
    // Issue #8: best-effort buyer push after a photo commits. Optional so the
    // staff upload path boots (and its tests construct the service) without it.
    @Optional() @Inject(PortalNotifier) private readonly portalNotifier?: PortalNotifier,
    // 2026-11-08: the STAFF side of the same event (project photo lead + team
    // managers). Optional for the same reason: existing tests build the service
    // with fewer dependencies and the upload must not require a notifier.
    @Optional()
    @Inject(SiteUpdateNotifier)
    private readonly siteUpdateNotifier?: SiteUpdateNotifier,
  ) {}

  private get client() {
    return this.prismaService.$client;
  }

  /** User table has no RLS: creator name for the upload response. */
  private async userName(
    tx: { user: { findUnique: (a: unknown) => Promise<{ name: string } | null> } },
    userId: string,
  ): Promise<string | null> {
    const u = await tx.user.findUnique({ where: { id: userId }, select: { name: true } });
    return u?.name ?? null;
  }

  /**
   * Assert the actor may act on the unit: ADMIN org-wide; everyone else
   * needs a ProjectTeam->TeamMember row or team-manager ownership for the
   * unit's project (resolved THROUGH Phase - Unit has no projectId).
   * RLS is the second wall; this is the messaging wall (RLS deny is silent).
   */
  private async assertUnitAccess(
    actor: JwtPayload,
    unitId: string,
  ): Promise<{ projectId: string; unitNumber: string }> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const unit = await tx.unit.findFirst({
        where: { id: unitId, organizationId: actor.organizationId },
        select: {
          id: true,
          unitNumber: true,
          assignedEngineerId: true,
          phase: { select: { projectId: true } },
        },
      });
      if (unit === null) throw new NotFoundException(`Unit not found.`);

      // 2026-11-10: an ENGINEER acts only on villas assigned to them. RLS already
      // hides other villas (404 above); this is the explicit second wall.
      if (actor.role === 'ENGINEER' && unit.assignedEngineerId !== actor.sub) {
        throw new ForbiddenException('This villa is not assigned to you.');
      }

      if (isAdminClass(actor.role))
        return { projectId: unit.phase.projectId, unitNumber: unit.unitNumber };
      if (
        actor.role === 'ENGINEER' ||
        actor.role === 'MANAGER' ||
        actor.role === 'SALES_EXEC' ||
        actor.role === 'TELECALLER'
      ) {
        const member = await tx.projectTeam.findFirst({
          where: {
            projectId: unit.phase.projectId,
            organizationId: actor.organizationId,
            team: {
              deletedAt: null,
              OR: [{ teamMembers: { some: { userId: actor.sub } } }, { managerId: actor.sub }],
            },
          },
          select: { projectId: true },
        });
        if (member !== null)
          return { projectId: unit.phase.projectId, unitNumber: unit.unitNumber };
      }
      throw new ForbiddenException('You are not assigned to this project.');
    });
  }

  async upload(actor: JwtPayload, unitId: string, dto: UploadPhotoDto): Promise<TimelinePhotoDto> {
    const { projectId, unitNumber } = await this.assertUnitAccess(actor, unitId);

    const buf = Buffer.from(dto.base64, 'base64');
    if (buf.length === 0) throw new BadRequestException('Empty file');
    if (buf.length > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(`File too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB)`);
    }

    // THE BYTES DECIDE THE TYPE, THE CLIENT ONLY HINTS AT IT (2026-11-06).
    //
    // `dto.mimeType` comes from the browser's File.type, which is derived from
    // the FILENAME. Phones hand back a JPEG's bytes under the name the camera
    // roll chose (`IMG_2676.PNG`), so the declared type can be wrong for
    // perfectly ordinary uploads - trusting it wrote `image/png` rows whose
    // stored bytes were JPEG, which the browser then refused to render under
    // nosniff. Sniffing here records the truth at rest.
    const reconciled = reconcileUploadMime(buf, dto.mimeType);
    if (reconciled === null) {
      throw new BadRequestException(
        'Unrecognised image format - the file is not a valid JPEG, PNG or WebP.',
      );
    }
    if (reconciled.mimeType === 'image/heic' || reconciled.mimeType === 'image/avif') {
      throw new BadRequestException(
        `This photo is ${reconciled.mimeType === 'image/heic' ? 'HEIC' : 'AVIF'} - please use JPEG, PNG or WebP (iPhone: Settings > Camera > Formats > Most Compatible).`,
      );
    }
    // Slice-1 allowlist (spec): JPEG/PNG/WebP. Anything else the sniffer CAN
    // identify (GIF, PDF, MP4, MP3) is still not a progress photo.
    if (
      reconciled.mimeType !== 'image/jpeg' &&
      reconciled.mimeType !== 'image/png' &&
      reconciled.mimeType !== 'image/webp'
    ) {
      throw new BadRequestException(
        `Unsupported image type: ${reconciled.mimeType}. Use JPEG, PNG or WebP.`,
      );
    }
    const mimeType = reconciled.mimeType;
    if (reconciled.declaredWasWrong) {
      this.logger.debug(
        `[progress] unit=${unitId} file="${dto.filename}" declared ${dto.mimeType} but the bytes are ${mimeType} - recording the bytes`,
      );
    }

    // Phase must belong to the unit's project (client-supplied taxonomy).
    const phaseOk = await withRlsContext(this.client, rlsContextFrom(actor), async (tx) =>
      tx.phase.findFirst({
        where: { id: dto.phaseId, projectId, organizationId: actor.organizationId },
        select: { name: true },
      }),
    );
    if (phaseOk === null) throw new NotFoundException('Phase not found for this project.');

    const takenAt = new Date(dto.takenAt);

    // The engineer's note wins; the generated caption stays the fallback so an
    // old client (and an engineer who types nothing) keeps today's behaviour.
    const caption = dto.caption ?? buildCaption(phaseOk.name, takenAt);

    // Bytes exist before the row references them; the DB write failing after
    // save() is compensated by storage.delete() (failure is logged, never
    // surfaced - the request 500s regardless).
    const stored = await this.storage.save(buf, {
      organizationId: actor.organizationId,
      mimeType,
      filename: dto.filename,
    });

    let created: TimelinePhotoDto;
    /** True when this is the unit's FIRST photo today - the staff notification
     *  is sent once per unit per day, not once per photo: an engineer shooting
     *  six angles of one villa must not produce six pings. Read inside the
     *  actor's own RLS context (they can see their own project's photos). */
    let firstPhotoToday = false;
    try {
      created = await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
        const startOfToday = new Date();
        startOfToday.setUTCHours(0, 0, 0, 0);
        const todayCount = await tx.progressPhoto.count({
          where: { unitId, organizationId: actor.organizationId, takenAt: { gte: startOfToday } },
        });
        firstPhotoToday = todayCount === 0;

        const photo = await tx.progressPhoto.create({
          data: {
            unitId,
            phaseId: dto.phaseId,
            organizationId: actor.organizationId,
            key: stored.key,
            mimeType,
            filename: stored.filename,
            caption,
            takenAt,
            stage: dto.stage ?? null,
            createdBy: actor.sub,
          },
          select: { id: true, createdAt: true },
        });
        return {
          id: photo.id,
          unitId,
          phaseId: dto.phaseId,
          phaseName: phaseOk.name,
          mimeType,
          filename: stored.filename,
          caption,
          takenAt: takenAt.toISOString(),
          stage: dto.stage ?? null,
          createdAt: photo.createdAt.toISOString(),
          creatorName: await this.userName(tx, actor.sub),
          creatorIsPhotoLead: null,
          mediaUrl: mediaUrlFor(stored.key),
          // The uploader just created this row, so they always hold the creator
          // arm of the mutation predicate. True regardless of role.
          canMutate: true,
        };
      });
    } catch (err) {
      // Compensation: the blob exists but the row does not.
      await this.storage.delete(stored.key);
      throw err;
    }

    // The row is committed. Tell the buyers (D8: best effort, never awaited,
    // never able to fail this response - the notifier catches and logs
    // everything itself). Deliberately OUTSIDE the try above: a notifier
    // fault must not trigger the blob-compensation delete.
    void this.portalNotifier?.notifyNewPhoto({
      organizationId: actor.organizationId,
      unitId,
      unitNumber,
      photoId: created.id,
      caption: created.caption,
    });
    // Same posture, staff direction, and gated to the first photo of the day.
    if (firstPhotoToday && this.siteUpdateNotifier !== undefined) {
      void this.siteUpdateNotifier.notifyNewPhoto({
        organizationId: actor.organizationId,
        projectId,
        unitId,
        unitNumber,
        photoId: created.id,
        caption: created.caption,
        uploaderId: actor.sub,
        uploaderName: created.creatorName,
      });
    }
    return created;
  }

  async timeline(
    actor: JwtPayload,
    unitId: string,
    cursorRaw: string | undefined,
  ): Promise<TimelineResponseDto> {
    const { projectId } = await this.assertUnitAccess(actor, unitId);
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      // Staff-only advisory flag (slice 4): should this viewer be offered the
      // edit/delete controls? Read here rather than in the mapper because the
      // authority lives in ProjectStaffRole for THIS project. RLS stays the
      // real wall - both mutation routes re-check by reading the row.
      const lead = await tx.projectStaffRole.findFirst({
        where: {
          projectId,
          userId: actor.sub,
          kind: 'PHOTO_LEAD',
          organizationId: actor.organizationId,
        },
        select: { projectId: true },
      });
      return readTimelinePage(tx, {
        unitId,
        organizationId: actor.organizationId,
        cursorRaw,
        scope: { viewer: { userId: actor.sub, role: actor.role }, leadsProject: lead !== null },
      });
    });
  }

  /** OWNER/ADMIN only (spec: MANAGER excluded regardless of canManageUsers). */
  async setPhotoLead(
    actor: JwtPayload,
    projectId: string,
    userId: string,
    dto: SetPhotoLeadDto,
  ): Promise<{ userId: string; projectId: string; photoLead: boolean }> {
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException('Only ADMIN or OWNER can assign the photo lead.');
    }
    await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId, organizationId: actor.organizationId },
        select: { id: true },
      });
      if (project === null) throw new NotFoundException('Project not found.');
      const user = await tx.user.findFirst({
        where: { id: userId, organizationId: actor.organizationId, deletedAt: null },
        select: { id: true },
      });
      if (user === null) throw new NotFoundException('User not found.');

      // 2026-11-07: on GRANT, the target must actually be STAFFED on this
      // project.
      //
      // Without this, any org user could be granted PHOTO_LEAD on any project:
      // the write succeeds, the audit row says "granted", and nothing visibly
      // changes - because the grant is only useful to someone who can already
      // see the project. Worse, the day a photo edit/delete route ships, an
      // unstaffed sales exec would hold project-wide authority over other
      // people's site photos.
      //
      // The predicate mirrors the read path exactly (assertUnitAccess and
      // progress_photo_select_member): a member of a ProjectTeam-linked team,
      // OR the manager who leads such a team. A manager supervising the site
      // qualifies without holding a TeamMember row, which matches the seeded
      // demo data (a MANAGER holds PHOTO_LEAD on Metro Heights).
      //
      // Deliberately NOT applied to REVOKE: removing someone from a team
      // leaves their ProjectStaffRole row behind, and a revoke that demanded
      // staffing could never clear that stale grant. Revoking is always
      // allowed (still ADMIN/OWNER-only, still audited).
      if (dto.photoLead) {
        const staffed = await tx.projectTeam.findFirst({
          where: {
            projectId,
            organizationId: actor.organizationId,
            team: {
              deletedAt: null,
              OR: [{ teamMembers: { some: { userId } } }, { managerId: userId }],
            },
          },
          select: { projectId: true },
        });
        if (staffed === null) {
          throw new BadRequestException(
            'That user is not staffed on this project - add them to one of its teams (or make them the team manager) before granting photo lead.',
          );
        }
      }

      if (dto.photoLead) {
        await tx.projectStaffRole.upsert({
          where: { userId_projectId_kind: { userId, projectId, kind: 'PHOTO_LEAD' } },
          update: {},
          create: {
            userId,
            projectId,
            kind: 'PHOTO_LEAD',
            organizationId: actor.organizationId,
            assignedById: actor.sub,
          },
        });
      } else {
        await tx.projectStaffRole.deleteMany({
          where: { userId, projectId, kind: 'PHOTO_LEAD', organizationId: actor.organizationId },
        });
      }
      await tx.auditLog.create({
        data: {
          userId: actor.sub,
          action: dto.photoLead ? 'progress.photo_lead_granted' : 'progress.photo_lead_revoked',
          organizationId: actor.organizationId,
          entityType: 'Project',
          entityId: projectId,
          before: {},
          after: { userId, photoLead: dto.photoLead },
          reason: `photo-lead ${dto.photoLead ? 'grant' : 'revoke'} by ${actor.email} (${actor.role})`,
        },
      });
    });
    return { userId, projectId, photoLead: dto.photoLead };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Photo correction (slice 4, shipped early with the slice-1/2 completion pass).
  //
  // The authority already existed and did nothing: progress_photo_update and
  // progress_photo_delete grant ADMIN, the CREATOR, or the project's PHOTO_LEAD,
  // but no route consumed them - so flipping the "Photo lead" switch was inert.
  //
  // Two rules this code must not get wrong:
  //   1. The authority is decided by RLS, not by a copy of the rule here. Both
  //      methods read the row inside the caller's context; if the policy denies,
  //      the read returns nothing and the answer is 404. That keeps ONE
  //      statement of who may act, and it cannot drift from the database.
  //   2. Editable surface is CAPTION ONLY. phaseId is a property of the unit
  //      (the upload stops asking), takenAt is evidence of when the site work
  //      happened, and unitId would move a buyer's photo to another home.
  // ──────────────────────────────────────────────────────────────────────────

  /** Resolve a photo the caller may mutate, or throw 404 (RLS decides). */
  private async assertPhotoMutable(
    tx: RlsTx,
    actor: JwtPayload,
    photoId: string,
  ): Promise<{ id: string; unitId: string; key: string; caption: string; stage: string | null }> {
    const photo = await tx.progressPhoto.findFirst({
      where: { id: photoId, organizationId: actor.organizationId },
      select: { id: true, unitId: true, key: true, caption: true, stage: true },
    });
    // No row here means either "does not exist" or "the write policy hides it".
    // Both answer 404 - a 403 would confirm a row the caller may not know about.
    if (photo === null) throw new NotFoundException('Photo not found.');
    return photo;
  }

  async updatePhoto(
    actor: JwtPayload,
    photoId: string,
    dto: UpdatePhotoDto,
  ): Promise<TimelinePhotoDto> {
    const updated = await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const photo = await this.assertPhotoMutable(tx, actor, photoId);
      // PARTIAL write: only the supplied fields move. A caption correction
      // never clears the stage and a stage correction never clears the caption
      // - that is the whole reason the schema is partial.
      await (tx as unknown as PrismaClient).progressPhoto.update({
        where: { id: photo.id },
        data: {
          ...(dto.caption !== undefined ? { caption: dto.caption } : {}),
          ...(dto.stage !== undefined ? { stage: dto.stage } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          userId: actor.sub,
          // A stage-only correction is not a caption correction; the caption
          // path keeps its historical action string so existing reports and
          // audit filters do not silently stop matching.
          action:
            dto.stage !== undefined ? 'progress.photo_updated' : 'progress.photo_caption_updated',
          organizationId: actor.organizationId,
          entityType: 'ProgressPhoto',
          entityId: photo.id,
          before: { caption: photo.caption, stage: photo.stage },
          after: { caption: dto.caption ?? photo.caption, stage: dto.stage ?? photo.stage },
          reason: `photo corrected by ${actor.email} (${actor.role})`,
        },
      });
      // Re-read through the shared mapper so the response is the SAME shape the
      // timeline renders - the client can swap the row without a refetch.
      const page = await readTimelinePage(tx, {
        unitId: photo.unitId,
        organizationId: actor.organizationId,
        cursorRaw: undefined,
        onlyPhotoId: photo.id,
        scope: { viewer: { userId: actor.sub, role: actor.role }, leadsProject: true },
      });
      return page.photos[0] ?? null;
    });

    if (updated === null) {
      throw new NotFoundException('Photo not found.');
    }
    return updated;
  }

  async deletePhoto(actor: JwtPayload, photoId: string): Promise<{ id: string; unitId: string }> {
    const removed = await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const photo = await this.assertPhotoMutable(tx, actor, photoId);

      const deleted = await (tx as unknown as PrismaClient).progressPhoto.deleteMany({
        where: { id: photo.id },
      });
      // deleteMany (not delete) so an RLS-denied row is a 0-count instead of a
      // P2025 throw that would look like a server fault.
      if (deleted.count === 0) throw new NotFoundException('Photo not found.');

      // Audit BEFORE the bytes go: the row is the audit's only anchor, and a
      // storage failure must not lose the record of the delete. Key + unit are
      // recorded so an operator can still find the blob if compensation failed.
      await tx.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'progress.photo_deleted',
          organizationId: actor.organizationId,
          entityType: 'ProgressPhoto',
          entityId: photo.id,
          before: { caption: photo.caption, key: photo.key, unitId: photo.unitId },
          after: {},
          reason: `photo deleted by ${actor.email} (${actor.role})`,
        },
      });
      return { id: photo.id, unitId: photo.unitId, key: photo.key };
    });

    // Bytes AFTER the row commits: a failed delete leaves an orphaned blob
    // (logged) rather than a row pointing at bytes that are gone. Same
    // posture as the upload's compensation path, inverted.
    try {
      await this.storage.delete(removed.key);
    } catch (err) {
      this.logger.warn(
        `[progress] photo ${removed.id} row deleted but blob ${removed.key} remains: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { id: removed.id, unitId: removed.unitId };
  }
}
