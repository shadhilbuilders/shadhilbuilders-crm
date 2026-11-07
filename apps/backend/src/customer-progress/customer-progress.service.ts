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
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional, forwardRef } from '@nestjs/common';
import { z } from 'zod';

import { isAdminClass } from '../users/roles';
import { STORAGE_PROVIDER } from '../storage/storage.tokens';
import type { StorageProvider } from '../storage/storage.provider';
import { MAX_UPLOAD_BYTES } from '../storage/storage.limits';
import { reconcileUploadMime } from '../storage/sniff-mime';
import { PrismaService } from '../prisma/prisma.module';
import { PortalNotifier } from '../customer-portal/portal-notifier.service';
import { withRlsContext, rlsContextFrom } from '@shadhil/database';
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
});
export type UploadPhotoDto = z.infer<typeof UploadPhotoSchema>;

export const SetPhotoLeadSchema = z.object({
  photoLead: z.boolean(),
});
export type SetPhotoLeadDto = z.infer<typeof SetPhotoLeadSchema>;

// Wire shapes + PAGE_SIZE + cursor codec live in progress-photo.mapper.ts so the
// buyer portal reads through the identical code path (issue #8). Re-exported
// here so existing importers (controller, tests) are unaffected.
export { PAGE_SIZE, decodeCursor, encodeCursor };
export type { TimelinePhotoDto, TimelineResponseDto };

// ── Service ─────────────────────────────────────────────────────────────────

/** Caption: "{phase.name} {en-GB month name} {year}" from takenAt (UTC). */
export function buildCaption(phaseName: string | null, takenAt: Date): string {
  const month = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(takenAt);
  const year = new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: 'UTC' }).format(takenAt);
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
  ) {}

  private get client() {
    return this.prismaService.$client;
  }

  /** User table has no RLS: creator name for the upload response. */
  private async userName(tx: { user: { findUnique: (a: unknown) => Promise<{ name: string } | null> } }, userId: string): Promise<string | null> {
    const u = await tx.user.findUnique({ where: { id: userId }, select: { name: true } });
    return u?.name ?? null;
  }

  /**
   * Assert the actor may act on the unit: ADMIN org-wide; everyone else
   * needs a ProjectTeam->TeamMember row or team-manager ownership for the
   * unit's project (resolved THROUGH Phase - Unit has no projectId).
   * RLS is the second wall; this is the messaging wall (RLS deny is silent).
   */
  private async assertUnitAccess(actor: JwtPayload, unitId: string): Promise<{ projectId: string; unitNumber: string }> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const unit = await tx.unit.findFirst({
        where: { id: unitId, organizationId: actor.organizationId },
        select: { id: true, unitNumber: true, phase: { select: { projectId: true } } },
      });
      if (unit === null) throw new NotFoundException(`Unit not found.`);

      if (isAdminClass(actor.role)) return { projectId: unit.phase.projectId, unitNumber: unit.unitNumber };
      if (actor.role === 'ENGINEER' || actor.role === 'MANAGER' || actor.role === 'SALES_EXEC' || actor.role === 'TELECALLER') {
        const member = await tx.projectTeam.findFirst({
          where: {
            projectId: unit.phase.projectId,
            organizationId: actor.organizationId,
            team: {
              deletedAt: null,
              OR: [
                { teamMembers: { some: { userId: actor.sub } } },
                { managerId: actor.sub },
              ],
            },
          },
          select: { projectId: true },
        });
        if (member !== null) return { projectId: unit.phase.projectId, unitNumber: unit.unitNumber };
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

    // Bytes exist before the row references them; the DB write failing after
    // save() is compensated by storage.delete() (failure is logged, never
    // surfaced - the request 500s regardless).
    const stored = await this.storage.save(buf, {
      organizationId: actor.organizationId,
      mimeType,
      filename: dto.filename,
    });

    let created: TimelinePhotoDto;
    try {
      created = await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
        const photo = await tx.progressPhoto.create({
          data: {
            unitId,
            phaseId: dto.phaseId,
            organizationId: actor.organizationId,
            key: stored.key,
            mimeType,
            filename: stored.filename,
            caption: buildCaption(phaseOk.name, takenAt),
            takenAt,
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
          caption: buildCaption(phaseOk.name, takenAt),
          takenAt: takenAt.toISOString(),
          createdAt: photo.createdAt.toISOString(),
          creatorName: await this.userName(tx, actor.sub),
          creatorIsPhotoLead: null,
          mediaUrl: mediaUrlFor(stored.key),
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
    return created;
  }

  async timeline(actor: JwtPayload, unitId: string, cursorRaw: string | undefined): Promise<TimelineResponseDto> {
    await this.assertUnitAccess(actor, unitId);
    return withRlsContext(this.client, rlsContextFrom(actor), (tx) =>
      readTimelinePage(tx, { unitId, organizationId: actor.organizationId, cursorRaw }),
    );
  }

  /** OWNER/ADMIN only (spec: MANAGER excluded regardless of canManageUsers). */
  async setPhotoLead(actor: JwtPayload, projectId: string, userId: string, dto: SetPhotoLeadDto): Promise<{ userId: string; projectId: string; photoLead: boolean }> {
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
      if (dto.photoLead) {
        await tx.projectStaffRole.upsert({
          where: { userId_projectId_kind: { userId, projectId, kind: 'PHOTO_LEAD' } },
          update: {},
          create: { userId, projectId, kind: 'PHOTO_LEAD', organizationId: actor.organizationId, assignedById: actor.sub },
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
}
