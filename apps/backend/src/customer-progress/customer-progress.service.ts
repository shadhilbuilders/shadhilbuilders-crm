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
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { z } from 'zod';

import { isAdminClass } from '../users/roles';
import { STORAGE_PROVIDER } from '../storage/storage.tokens';
import type { StorageProvider } from '../storage/storage.provider';
import { MAX_UPLOAD_BYTES } from '../storage/storage.limits';
import { PrismaService } from '../prisma/prisma.module';
import { withRlsContext, rlsContextFrom, type RlsTx } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';

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

const PAGE_SIZE = 50;

/** Timeline entry DTO (single authoritative shape, pinned by the spec). */
export interface TimelinePhotoDto {
  id: string;
  unitId: string;
  phaseId: string | null;
  phaseName: string | null;
  mimeType: string;
  filename: string;
  caption: string;
  takenAt: string;
  createdAt: string;
  creatorName: string | null;
  creatorIsPhotoLead: boolean | null;
  mediaUrl: string;
}

export interface TimelineResponseDto {
  photos: TimelinePhotoDto[];
  nextCursor: string | null;
}

// ── Service ─────────────────────────────────────────────────────────────────

/** Caption: "{phase.name} {en-GB month name} {year}" from takenAt (UTC). */
export function buildCaption(phaseName: string | null, takenAt: Date): string {
  const month = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(takenAt);
  const year = new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: 'UTC' }).format(takenAt);
  return `${phaseName ?? 'Site photo'} ${month} ${year}`;
}

/** Cursor codec: opaque base64 JSON {takenAt, id}. */
export function encodeCursor(takenAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ takenAt: takenAt.toISOString(), id }), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): { takenAt: Date; id: string } | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { takenAt?: unknown }).takenAt !== 'string' ||
      typeof (parsed as { id?: unknown }).id !== 'string'
    ) {
      return null;
    }
    const { takenAt, id } = parsed as { takenAt: string; id: string };
    return { takenAt: new Date(takenAt), id };
  } catch {
    return null; // malformed cursor = fresh first page (log at debug upstream)
  }
}

@Injectable()
export class CustomerProgressService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(forwardRef(() => STORAGE_PROVIDER)) private readonly storage: StorageProvider,
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
  private async assertUnitAccess(actor: JwtPayload, unitId: string): Promise<{ projectId: string }> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const unit = await tx.unit.findFirst({
        where: { id: unitId, organizationId: actor.organizationId },
        select: { id: true, phase: { select: { projectId: true } } },
      });
      if (unit === null) throw new NotFoundException(`Unit not found.`);

      if (isAdminClass(actor.role)) return { projectId: unit.phase.projectId };
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
        if (member !== null) return { projectId: unit.phase.projectId };
      }
      throw new ForbiddenException('You are not assigned to this project.');
    });
  }

  async upload(actor: JwtPayload, unitId: string, dto: UploadPhotoDto): Promise<TimelinePhotoDto> {
    const { projectId } = await this.assertUnitAccess(actor, unitId);

    const buf = Buffer.from(dto.base64, 'base64');
    if (buf.length === 0) throw new BadRequestException('Empty file');
    if (buf.length > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(`File too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB)`);
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
      mimeType: dto.mimeType,
      filename: dto.filename,
    });

    try {
      return await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
        const photo = await tx.progressPhoto.create({
          data: {
            unitId,
            phaseId: dto.phaseId,
            organizationId: actor.organizationId,
            key: stored.key,
            mimeType: dto.mimeType,
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
          mimeType: dto.mimeType,
          filename: stored.filename,
          caption: buildCaption(phaseOk.name, takenAt),
          takenAt: takenAt.toISOString(),
          createdAt: photo.createdAt.toISOString(),
          creatorName: await this.userName(tx, actor.sub),
          creatorIsPhotoLead: null,
          mediaUrl: `/api/bff/media/${encodeURIComponent(stored.key)}`,
        };
      });
    } catch (err) {
      // Compensation: the blob exists but the row does not.
      await this.storage.delete(stored.key);
      throw err;
    }
  }

  async timeline(actor: JwtPayload, unitId: string, cursorRaw: string | undefined): Promise<TimelineResponseDto> {
    await this.assertUnitAccess(actor, unitId);
    const cursor = decodeCursor(cursorRaw); // malformed/absent = fresh page

    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      // Stable composite ordering (spec): takenAt DESC, id DESC.
      const rows = await tx.progressPhoto.findMany({
        where: {
          unitId,
          organizationId: actor.organizationId,
          ...(cursor !== null
            ? {
                OR: [
                  { takenAt: { lt: cursor.takenAt } },
                  { takenAt: cursor.takenAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ takenAt: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE + 1, // fetch one extra to know whether a next page exists
        select: { id: true, unitId: true, phaseId: true, phase: { select: { name: true } }, mimeType: true, filename: true, caption: true, takenAt: true, createdAt: true, key: true },
      });

      const hasMore = rows.length > PAGE_SIZE;
      const page = rows.slice(0, PAGE_SIZE);

      // Creator labels resolved per-photo via the SECURITY DEFINER helper
      // (TeamMember RLS hides other members' rows by design).
      const ids = page.map((r) => r.id);
      // Creator labels via the SECURITY DEFINER helper, one call per photo
      // (the function takes a single id; a 50-photo page is at most 50 tiny
      // round trips - correct first, batch in slice 2 if pages ever grow).
      const labelRows = await Promise.all(
        page.map(async (r) => {
          const rows = await tx.$queryRaw<Array<{ creator_name: string | null; creator_is_photo_lead: boolean | null }>>`
            SELECT creator_name, creator_is_photo_lead FROM progress_photo_creator_label(${r.id})`;
          return [r.id, rows[0] ?? null] as const;
        }),
      );
      const labelById = new Map(labelRows);

      // Assemble the DTO page.
      const photos: TimelinePhotoDto[] = page.map((r) => {
        const label = labelById.get(r.id) ?? null;
        return {
          id: r.id,
          unitId: r.unitId,
          phaseId: r.phaseId,
          phaseName: r.phase?.name ?? null,
          mimeType: r.mimeType,
          filename: r.filename,
          caption: r.caption,
          takenAt: r.takenAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
          creatorName: label?.creator_name ?? null,
          creatorIsPhotoLead: label?.creator_is_photo_lead ?? null,
          mediaUrl: `/api/bff/media/${encodeURIComponent(r.key)}`,
        };
      });

      const last = page[page.length - 1];
      return {
        photos,
        nextCursor: hasMore && last ? encodeCursor(last.takenAt, last.id) : null,
      };
    });
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
