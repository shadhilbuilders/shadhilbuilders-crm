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
//
// `canMutate` (2026-11-07, slice 4): a per-row COURTESY flag for the staff UI
// saying whether this session should be offered the edit/delete controls. It
// mirrors the progress_photo_update / _delete predicate (ADMIN, the creator, or
// the project's photo lead) but it is NOT the authority - RLS is, and both
// mutation routes re-read the row inside the caller's context. Computed here
// because the id-based facts (who uploaded it, does this viewer lead the
// project) are not on the wire DTO and must not be: the buyer portal consumes
// this same shape and has no business receiving staff authority flags.
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
  /**
   * Construction stage recorded with the capture (2026-11-08). Null when the
   * photo recorded none - every surface then says "Stage not set", never
   * "Not started". The unit's CURRENT stage is this field on its newest photo.
   */
  stage: string | null;
  createdAt: string;
  creatorName: string | null;
  creatorIsPhotoLead: boolean | null;
  mediaUrl: string;
  /**
   * May this session be offered the edit/delete controls? Mirrors the
   * progress_photo_update/_delete predicate (ADMIN, the creator, or the
   * project's photo lead). Always present so the buyer and staff timelines
   * keep the identical wire shape the spec requires; always false for a
   * CUSTOMER, who has no write arm on any table.
   *
   * ADVISORY ONLY: both mutation routes re-read the row inside the caller's
   * RLS context, so a wrong value here cannot grant anything.
   */
  canMutate: boolean;
}

export interface TimelineResponseDto {
  photos: TimelinePhotoDto[];
  nextCursor: string | null;
}

/** Cursor codec: opaque base64 JSON {takenAt, id}. */
export function encodeCursor(takenAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ takenAt: takenAt.toISOString(), id }), 'utf8').toString(
    'base64url',
  );
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
  stage: string | null;
  createdAt: Date;
  key: string;
  createdBy: string | null;
}

interface CreatorLabel {
  creator_name: string | null;
  creator_is_photo_lead: boolean | null;
}

/** A row of progress_photo_creator_labels(): the label plus which photo it is for. */
interface CreatorLabelRow extends CreatorLabel {
  photo_id: string;
}

/**
 * Who is asking, for the advisory `canMutate` flag. Mirrors the RLS predicate
 * on progress_photo_update / _delete; see the file header for why this is a
 * courtesy and not the wall. `viewer: null` is the buyer portal, which gets
 * `canMutate: false` on every row (CUSTOMER has no write arm anywhere).
 */
export interface ViewerScope {
  /** null for the buyer portal. */
  viewer: { userId: string; role: string } | null;
  /** True when the viewer holds PHOTO_LEAD on this photo's project. */
  leadsProject: boolean;
}

/** The RLS mutation predicate, restated for the UI. ADMIN (OWNER travels as ADMIN). */
export function canMutateRow(row: { createdBy: string | null }, scope: ViewerScope): boolean {
  if (scope.viewer === null) return false; // buyer: read-only by design (D5)
  if (scope.viewer.role === 'ADMIN' || scope.viewer.role === 'OWNER') return true;
  if (scope.leadsProject) return true;
  return row.createdBy !== null && row.createdBy === scope.viewer.userId;
}

/** Map one stored row (+ its creator label) to the wire DTO. */
export function toTimelinePhotoDto(
  row: PhotoRow,
  label: CreatorLabel | null,
  scope: ViewerScope,
): TimelinePhotoDto {
  return {
    id: row.id,
    unitId: row.unitId,
    phaseId: row.phaseId,
    phaseName: row.phase?.name ?? null,
    mimeType: row.mimeType,
    filename: row.filename,
    caption: row.caption,
    takenAt: row.takenAt.toISOString(),
    stage: row.stage,
    createdAt: row.createdAt.toISOString(),
    creatorName: label?.creator_name ?? null,
    creatorIsPhotoLead: label?.creator_is_photo_lead ?? null,
    mediaUrl: mediaUrlFor(row.key),
    canMutate: canMutateRow(row, scope),
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
  args: {
    unitId: string;
    organizationId: string;
    cursorRaw: string | undefined;
    /**
     * Read exactly this one photo instead of a page (2026-11-07). Used by
     * updatePhoto so the edit response is the SAME DTO the timeline renders -
     * the client can swap the row in place. Pagination args are then ignored.
     */
    onlyPhotoId?: string;
    /**
     * Who is asking, for the advisory canMutate flag. Required so the buyer and
     * staff timelines emit the identical wire shape; the portal passes
     * `viewer: null` and every row comes back `canMutate: false`.
     */
    scope: ViewerScope;
  },
): Promise<TimelineResponseDto> {
  const cursor = decodeCursor(args.cursorRaw); // malformed/absent = fresh page

  const rows = await tx.progressPhoto.findMany({
    where: {
      unitId: args.unitId,
      organizationId: args.organizationId,
      ...(args.onlyPhotoId !== undefined ? { id: args.onlyPhotoId } : {}),
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
    take: args.onlyPhotoId !== undefined ? 1 : PAGE_SIZE + 1, // one extra row tells us whether a next page exists
    select: {
      id: true,
      unitId: true,
      phaseId: true,
      phase: { select: { name: true } },
      mimeType: true,
      filename: true,
      caption: true,
      takenAt: true,
      stage: true,
      createdAt: true,
      key: true,
      createdBy: true,
    },
  });

  const hasMore = args.onlyPhotoId === undefined && rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);

  // ONE query for the whole page (2026-11-09). This used to call
  // progress_photo_creator_label() once per photo inside Promise.all - but
  // $queryRaw in an interactive transaction runs on one pinned connection, so
  // those 50 promises queued rather than parallelised. Measured: 117ms for 50
  // sequential calls vs 4ms for the batched helper, with byte-identical output
  // (verified row-for-row against the dev DB, 0 differences both directions).
  //
  // The helper applies the visibility predicate PER PHOTO, so an unreadable
  // photo simply has no row here and reads "Unknown", exactly as before.
  const labelRows =
    page.length === 0
      ? []
      : await tx.$queryRaw<CreatorLabelRow[]>`
          SELECT photo_id, creator_name, creator_is_photo_lead
          FROM progress_photo_creator_labels(${page.map((r) => r.id)}::text[])`;
  const labelById = new Map<string, CreatorLabel>(
    labelRows.map((l) => [
      l.photo_id,
      { creator_name: l.creator_name, creator_is_photo_lead: l.creator_is_photo_lead },
    ]),
  );

  const photos = page.map((r) => toTimelinePhotoDto(r, labelById.get(r.id) ?? null, args.scope));
  const last = page[page.length - 1];
  return {
    photos,
    nextCursor: hasMore && last ? encodeCursor(last.takenAt, last.id) : null,
  };
}
