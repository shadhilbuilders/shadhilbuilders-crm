// Shared progress-photo read path (issue #7 slice 1, reused by issue #8).
//
// The staff timeline (customer-progress) and the buyer portal
// (customer-portal) must return the SAME DTO page in the SAME order with the
// SAME cursor semantics. One implementation, two callers: a drift between the
// two would show a buyer a different timeline than the staff previewed.
//
// Extracted from customer-progress.service.ts with NO behaviour change: same
// ordering (takenAt DESC, id DESC), same page size, same creator-label
// helper, same DTO shape. Callers own the access check; this file owns
// reading and mapping inside the caller's RLS transaction.
import type { RlsTx } from '@shadhil/database';

export const PAGE_SIZE = 50;

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
    // Shape is not enough: `takenAt` must also PARSE. A cursor with a valid
    // shape but an unparseable date (truncated by a proxy, hand-edited, or
    // written by an older encoder) produced `new Date('not-a-date')` = an
    // Invalid Date, which Prisma rejects with PrismaClientValidationError =>
    // a 500 on a GET that is supposed to degrade to a fresh first page.
    const when = new Date(takenAt);
    if (Number.isNaN(when.getTime())) return null;
    return { takenAt: when, id };
  } catch {
    return null; // malformed cursor = fresh first page (log at debug upstream)
  }
}

export function mediaUrlFor(key: string): string {
  return `/api/bff/media/${encodeURIComponent(key)}`;
}

interface PhotoRow {
  id: string;
  unitId: string;
  phaseId: string | null;
  phase: { name: string } | null;
  mimeType: string;
  filename: string;
  caption: string;
  takenAt: Date;
  createdAt: Date;
  key: string;
}

interface CreatorLabel {
  creator_name: string | null;
  creator_is_photo_lead: boolean | null;
}

/** Map one stored row (+ its creator label) to the wire DTO. */
export function toTimelinePhotoDto(row: PhotoRow, label: CreatorLabel | null): TimelinePhotoDto {
  return {
    id: row.id,
    unitId: row.unitId,
    phaseId: row.phaseId,
    phaseName: row.phase?.name ?? null,
    mimeType: row.mimeType,
    filename: row.filename,
    caption: row.caption,
    takenAt: row.takenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    creatorName: label?.creator_name ?? null,
    creatorIsPhotoLead: label?.creator_is_photo_lead ?? null,
    mediaUrl: mediaUrlFor(row.key),
  };
}

/**
 * One timeline page for a unit, inside the caller's RLS transaction.
 * Stable composite ordering (spec): takenAt DESC, id DESC. Creator labels
 * come from the SECURITY DEFINER helper (TeamMember RLS hides other members'
 * rows by design), one call per photo.
 */
export async function readTimelinePage(
  tx: RlsTx,
  args: { unitId: string; organizationId: string; cursorRaw: string | undefined },
): Promise<TimelineResponseDto> {
  const cursor = decodeCursor(args.cursorRaw); // malformed/absent = fresh page

  const rows = await tx.progressPhoto.findMany({
    where: {
      unitId: args.unitId,
      organizationId: args.organizationId,
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
    select: {
      id: true,
      unitId: true,
      phaseId: true,
      phase: { select: { name: true } },
      mimeType: true,
      filename: true,
      caption: true,
      takenAt: true,
      createdAt: true,
      key: true,
    },
  });

  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);

  const labelRows = await Promise.all(
    page.map(async (r) => {
      const found = await tx.$queryRaw<CreatorLabel[]>`
        SELECT creator_name, creator_is_photo_lead FROM progress_photo_creator_label(${r.id})`;
      return [r.id, found[0] ?? null] as const;
    }),
  );
  const labelById = new Map(labelRows);

  const photos = page.map((r) => toTimelinePhotoDto(r, labelById.get(r.id) ?? null));
  const last = page[page.length - 1];
  return {
    photos,
    nextCursor: hasMore && last ? encodeCursor(last.takenAt, last.id) : null,
  };
}
