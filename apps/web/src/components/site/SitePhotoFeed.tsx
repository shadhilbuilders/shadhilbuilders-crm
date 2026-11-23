'use client';

// SitePhotoFeed (2026-11-08): the capture screen's photo feed, presentational.
//
// The photo IS the content and the note IS the headline - the old row was a
// 64px thumbnail with a truncated caption, which is exactly backwards for a
// photo job. So: full-width 4:3 image, then the note at `text-sm font-medium`
// clamped to two lines (never truncated), then one muted line with the relative
// time and the uploader.
//
// Rules pinned by test:
//   - grouped by month (reusing the portal's `groupByMonth` - one date-grouping
//     implementation, not two),
//   - no per-row phase chip: the phase is constant per unit and already in the
//     header, so the chip discriminates nothing,
//   - plain <img>, never next/image: the media URL is a same-origin
//     cookie-authenticated BFF route and the optimizer would drop the session.
import { Alert, Button, CardRoot, Skeleton } from '@paalstack/react-ui';
import { LuRefreshCw } from '@paalstack/react-icons/lu';

import type { ReactNode } from 'react';

import { VideoBadge } from './VideoBadge';

import { groupByMonth } from '@/components/portal/portal-format';
import type { TimelinePhoto } from '@/hooks/queries/customer-progress';
import { constructionStageLabel } from '@/lib/labels';
import { relativeCaptureTime } from '@/lib/site-photos';
import { videoTileName } from '@/lib/site-video/format';

/** The first two photos load eagerly (above the fold); the rest lazily. */
const EAGER_IMAGES = 2;

export type UploadingState = {
  /** Local object URL of the blob that will actually upload. */
  previewUrl: string;
  note: string;
  status: 'uploading' | 'failed';
};

export type SitePhotoFeedProps = {
  photos: readonly TimelinePhoto[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onOpenPhoto: (photoId: string) => void;
  /** In-flight uploads, newest first, rendered above the committed feed. */
  uploading: readonly UploadingState[];
  onRetryUpload: (index: number) => void;
  onDiscardUpload: (index: number) => void;
  now: Date;
  unitLabel: string;
  /**
   * The row's actions slot. Injected rather than imported so this feed stays
   * renderable without a query client, and so the authority decision
   * (`photo.canMutate`) stays inside the component that owns it. The capture
   * page passes `ProgressPhotoActions`.
   */
  renderActions?: (photo: TimelinePhoto) => ReactNode;
};

/** Loading: cards shaped like the real card, not 80px rectangles. */
function FeedSkeleton() {
  return (
    <div
      className="space-y-4"
      data-qa="progress-skeleton"
      role="status"
      aria-busy="true"
      aria-label="Loading photos"
    >
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}

function UploadingCard({
  upload,
  index,
  onRetry,
  onDiscard,
}: {
  upload: UploadingState;
  index: number;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const failed = upload.status === 'failed';
  return (
    <div
      data-qa="site-uploading-card"
      data-state={upload.status}
      className="border-border flex items-center gap-3 rounded-lg border p-2"
    >
      {/* The blob that will upload, not the original file. */}
      <img
        src={upload.previewUrl}
        alt={upload.note.length > 0 ? upload.note : 'Photo being uploaded'}
        className="bg-muted-soft size-20 shrink-0 rounded-md object-cover opacity-60"
      />
      {failed ? (
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-destructive text-sm font-medium" role="alert">
            That photo did not upload. Nothing was saved.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={onRetry}
              data-qa="site-upload-retry"
            >
              Try again
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="flex-1"
              onClick={onDiscard}
              data-qa="site-upload-discard"
            >
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm" data-qa="site-uploading-label">
          Uploading photo...
        </p>
      )}
      <span className="sr-only">{`Upload ${index + 1}`}</span>
    </div>
  );
}

/** Play glyph + duration over the poster. Decorative: the button's name carries both. */
/** Staff-facing words for a delivery outcome; null when there is nothing to say. */
function deliveryNoteOf(row: {
  whatsappStatus?: keyof typeof DELIVERY_WORDS | null;
}): string | null {
  const status = row.whatsappStatus;
  return status === null || status === undefined ? null : (DELIVERY_WORDS[status] ?? null);
}

const DELIVERY_WORDS = {
  PENDING: 'Sending to buyer…',
  SENT: 'Sent to buyer',
  SKIPPED_WINDOW: 'Not sent: buyer window closed',
  SKIPPED_NO_TEMPLATE: 'Not sent: no approved template',
  SKIPPED_NO_BUYER: 'Not sent: no buyer on this unit',
  SKIPPED_NO_CONSENT: 'Not sent: buyer has not opted in',
  // The switch, not a fault: "off" is the operator's decision, and the words say
  // so rather than blaming a missing template or a failed send.
  SKIPPED_DISABLED: 'Not sent: buyer updates switched off',
  FAILED: 'Not sent: delivery failed',
} as const;

function PhotoCard({
  photo,
  index,
  unitLabel,
  now,
  onOpen,
  actions,
}: {
  photo: TimelinePhoto;
  index: number;
  unitLabel: string;
  now: Date;
  onOpen: () => void;
  actions?: ReactNode;
}) {
  const isVideo = photo.kind === 'VIDEO';
  const deliveryNote = deliveryNoteOf(photo);
  const alt =
    photo.caption.trim().length > 0
      ? `Unit ${unitLabel}, "${photo.caption}"`
      : `Unit ${unitLabel} progress photo`;
  return (
    <li data-qa="progress-photo-row">
      <CardRoot className="hover:bg-muted/50 flex-row items-center gap-3 overflow-hidden p-2 transition-colors">
        {/* The whole row (thumbnail + note) opens the full-size viewer; only the
          actions menu, a sibling of this button, does something else. */}
        <button
          type="button"
          onClick={onOpen}
          aria-haspopup="dialog"
          aria-label={
            isVideo
              ? `Open the ${videoTileName(photo.durationMs).toLowerCase()} from ${relativeCaptureTime(photo.takenAt, now)}`
              : `Open the photo from ${relativeCaptureTime(photo.takenAt, now)}`
          }
          data-qa="site-photo-open"
          className="focus-visible:ring-ring flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left focus-visible:ring-2 focus-visible:outline-none"
        >
          {/* Same-origin, cookie-authenticated BFF media URL: next/image's
            optimizer would drop the session. */}
          <span className="bg-muted-soft relative block size-20 shrink-0 overflow-hidden rounded-md">
            <img
              src={photo.mediaUrl}
              alt={alt}
              width={160}
              height={160}
              loading={index < EAGER_IMAGES ? 'eager' : 'lazy'}
              decoding="async"
              className="size-full object-cover"
              data-qa="progress-photo-thumb"
            />
            {isVideo ? <VideoBadge durationMs={photo.durationMs} /> : null}
          </span>
          <span className="min-w-0 flex-1">
            {/* The NOTE is the headline: two lines, never truncated. */}
            <span
              className="line-clamp-2 block text-sm leading-snug font-medium"
              data-qa="progress-caption"
            >
              {photo.caption}
            </span>
            <span className="text-muted-foreground mt-1 block text-xs">
              <time dateTime={photo.takenAt} data-qa="progress-date">
                {relativeCaptureTime(photo.takenAt, now)}
              </time>
              {photo.creatorName !== null ? (
                <>
                  {' · '}
                  <span data-qa="progress-uploader">{photo.creatorName}</span>
                </>
              ) : null}
              {photo.stage !== null ? (
                <>
                  {' · '}
                  <span data-qa="progress-stage">{constructionStageLabel(photo.stage)}</span>
                </>
              ) : null}
              {deliveryNote !== null ? (
                <>
                  {' · '}
                  {/* Staff-only bookkeeping, in plain words: support answers
                      "the buyer says they never got it" without a database
                      query. Null (buyer view, pre-step-8 row) renders nothing
                      rather than an ambiguous "not sent". */}
                  <span data-qa="progress-whatsapp" data-status={photo.whatsappStatus}>
                    {deliveryNote}
                  </span>
                </>
              ) : null}
            </span>
          </span>
        </button>
        {/* Edit note / Delete photo, behind a menu; same canMutate gate. */}
        {actions}
      </CardRoot>
    </li>
  );
}

export function SitePhotoFeed({
  photos,
  isLoading,
  isError,
  onRetry,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onOpenPhoto,
  uploading,
  onRetryUpload,
  onDiscardUpload,
  now,
  unitLabel,
  renderActions,
}: SitePhotoFeedProps) {
  if (isLoading) return <FeedSkeleton />;

  if (isError) {
    return (
      <Alert
        softBackground="danger"
        data-qa="progress-load-error"
        description={
          <span className="flex items-center gap-2">
            <span className="flex-1">Could not load the photos for this unit.</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRetry}
              data-qa="progress-load-retry"
            >
              <LuRefreshCw className="size-4" aria-hidden="true" /> Retry
            </Button>
          </span>
        }
      />
    );
  }

  let index = 0;
  const groups = groupByMonth(photos);

  return (
    <div className="space-y-6" data-qa="progress-timeline">
      {uploading.map((upload, i) => (
        <UploadingCard
          key={`upload-${upload.previewUrl}`}
          upload={upload}
          index={i}
          onRetry={() => onRetryUpload(i)}
          onDiscard={() => onDiscardUpload(i)}
        />
      ))}

      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`site-month-${group.key}`}>
          <h2
            id={`site-month-${group.key}`}
            className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase"
          >
            {group.label}
          </h2>
          <ol className="space-y-4">
            {group.photos.map((photo) => {
              const card = (
                <PhotoCard
                  key={photo.id}
                  photo={photo}
                  index={index}
                  unitLabel={unitLabel}
                  now={now}
                  onOpen={() => onOpenPhoto(photo.id)}
                  actions={renderActions?.(photo)}
                />
              );
              index += 1;
              return card;
            })}
          </ol>
        </section>
      ))}

      {/* The cursor rule is unchanged: only the LAST page decides. */}
      {hasMore ? (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={onLoadMore}
          disabled={isLoadingMore}
          data-qa="progress-load-more"
        >
          {isLoadingMore ? 'Loading...' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
}

/** One card, reused by the tests to prove the shape without a query client. */
export function SitePhotoCard(props: {
  photo: TimelinePhoto;
  index: number;
  unitLabel: string;
  now: Date;
  onOpen: () => void;
  actions?: ReactNode;
}) {
  return (
    <ul>
      <PhotoCard {...props} />
    </ul>
  );
}
