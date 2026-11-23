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
import type { RlsTx, SiteUpdateDeliveryStatus } from '@shadhil/database';

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
  /** PHOTO or VIDEO (2026-11-23). One timeline holds both. */
  kind: 'PHOTO' | 'VIDEO';
  /**
   * Same-origin BFF path to what an `<img>` may render: the photo itself, or a
   * VIDEO's POSTER. It never points at a clip, so existing image tiles cannot
   * try to paint an MP4. Empty on an archived tombstone and on a video with no
   * poster, whose keys are cleared after the purge.
   */
  mediaUrl: string;
  /** Same-origin path to the clip for a live VIDEO; null for a photo or a tombstone. */
  videoUrl: string | null;
  /** Client-reported duration (trusted, bounded 1..45s by a CHECK); null for photos. */
  durationMs: number | null;
  /** Whether the clip carries an audio track. False for photos. */
  hasAudio: boolean;
  /** True once the clip was purged: the row is a tombstone with no bytes. */
  archived: boolean;
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
  /**
   * Staff only (step 8): how the buyer-facing WhatsApp send for this row's
   * BATCH ended, so support can answer "the buyer says they never got it"
   * without opening the database. Null for the buyer's own timeline (they do
   * not need our delivery bookkeeping), for a row saved before step 8, and for
   * a batch with no delivery row at all.
   */
  whatsappStatus?: SiteUpdateDeliveryStatus | null;
  /**
   * When the buyer opened it, staff only, ISO. Sent alongside the status rather
   * than folded into the label so the client decides the wording of the time
   * (it already renders capture times in the viewer's day terms). Null when the
   * status is anything but READ, and for every case whatsappStatus is null.
   */
  whatsappReadAt?: string | null;
  /**
   * When it reached the phone (staff only, ISO). Paired with whatsappReadAt so
   * the client can say how long the buyer sat on it; null wherever the status is
   * null, and for every row saved before the receipt mapping existed.
   */
  whatsappDeliveredAt?: string | null;
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
  /**
   * Null on an archived tombstone (2026-11-23): the purge deletes the objects
   * and then clears the keys, so the row can outlive the bytes. No such row
   * exists yet; step 5 gives the DTO its tombstone state and `mediaUrl` its
   * poster branch, and this file stops lying about the type in the meantime.
   */
  key: string | null;
  createdBy: string | null;
  kind: 'PHOTO' | 'VIDEO';
  posterKey: string | null;
  durationMs: number | null;
  hasAudio: boolean;
  archivedAt: Date | null;
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

/**
 * The URL an `<img>` may use. A photo points at its own bytes; a video points
 * at its POSTER, never at the clip. A row with nothing left to show (a purged
 * tombstone, or a clip whose poster failed) resolves to an empty string.
 */
function imageUrlFor(row: PhotoRow): string {
  const key = row.kind === 'VIDEO' ? row.posterKey : row.key;
  return key === null ? '' : mediaUrlFor(key);
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
    kind: row.kind,
    mediaUrl: imageUrlFor(row),
    videoUrl: row.kind === 'VIDEO' && row.key !== null ? mediaUrlFor(row.key) : null,
    durationMs: row.durationMs,
    hasAudio: row.hasAudio,
    archived: row.archivedAt !== null,
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
      kind: true,
      posterKey: true,
      durationMs: true,
      hasAudio: true,
      archivedAt: true,
      batchId: true,
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

  // Delivery status, staff only, ONE query for the page (step 8). The buyer's
  // own timeline omits it: it is our bookkeeping, not their record.
  const deliveryByBatch = new Map<
    string,
    { status: SiteUpdateDeliveryStatus; readAt: Date | null; deliveredAt: Date | null }
  >();
  if (args.scope.viewer !== null) {
    const batches = [...new Set(page.map((r) => r.batchId).filter((b): b is string => b !== null))];
    if (batches.length > 0) {
      // Optional delegate: a row read through a narrower client than the full
      // Prisma one (a test double, or a future read replica without this table)
      // must still render the timeline - the status is a courtesy, and its
      // absence must never blank a feed of photos.
      const delegate = (
        tx as unknown as {
          siteUpdateDelivery?: {
            findMany(a: unknown): Promise<
              Array<{
                batchId: string;
                status: SiteUpdateDeliveryStatus;
                readAt: Date | null;
                deliveredAt: Date | null;
              }>
            >;
          };
        }
      ).siteUpdateDelivery;
      const deliveries =
        delegate === undefined
          ? []
          : await delegate.findMany({
              where: { organizationId: args.organizationId, batchId: { in: batches } },
              select: { batchId: true, status: true, readAt: true, deliveredAt: true },
            });
      for (const d of deliveries) {
        deliveryByBatch.set(d.batchId, {
          status: d.status,
          readAt: d.readAt,
          deliveredAt: d.deliveredAt,
        });
      }
    }
  }

  const photos = page.map((r) => ({
    ...toTimelinePhotoDto(r, labelById.get(r.id) ?? null, args.scope),
    whatsappStatus:
      args.scope.viewer === null || r.batchId === null
        ? null
        : (deliveryByBatch.get(r.batchId)?.status ?? null),
    whatsappReadAt:
      args.scope.viewer === null || r.batchId === null
        ? null
        : (deliveryByBatch.get(r.batchId)?.readAt?.toISOString() ?? null),
    whatsappDeliveredAt:
      args.scope.viewer === null || r.batchId === null
        ? null
        : (deliveryByBatch.get(r.batchId)?.deliveredAt?.toISOString() ?? null),
  }));
  const last = page[page.length - 1];
  return {
    photos,
    nextCursor: hasMore && last ? encodeCursor(last.takenAt, last.id) : null,
  };
}
