'use client';

// PortalTimeline (issue #8 slice 2): the buyer's construction-progress feed.
//
// Presentational: state comes in as props so every state is renderable (and
// testable) without a query client. Mirrors lead-timeline's four states:
//   loading -> skeleton shaped like the list     error -> inline banner + retry
//   empty   -> warm, forward-looking copy        data  -> rows (+ load more)
//
// Rows, not cards (design): one full-width photo, then phase chip + date.
// ONE accent: green marks only the phase of the newest photo; every other
// chip is neutral. Each month is a <section> with its own <h2> and <ol>, so
// the page has a heading outline AND ordered-list semantics.
import { Badge, Button, Empty } from '@paalstack/react-ui';
import { LuCamera, LuRefreshCw } from '@paalstack/react-icons/lu';

import type { TimelinePhoto } from '@/hooks/queries/customer-portal';

import { formatDay, groupByMonth, photoAlt } from './portal-format';

/** The first two images load eagerly (above the fold); the rest lazily. */
const EAGER_IMAGES = 2;

export type PortalTimelineProps = {
  photos: readonly TimelinePhoto[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onOpenPhoto: (photoId: string) => void;
  /** Photo opened from a push deep link: gets the single motion moment. */
  focusedPhotoId?: string | null;
};

function TimelineSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading photos" data-qa="portal-skeleton" className="space-y-6">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <div className="bg-muted-soft aspect-[4/3] w-full animate-pulse rounded-lg" />
          <div className="bg-muted-soft h-6 w-40 animate-pulse rounded-md" />
        </div>
      ))}
    </div>
  );
}

function PhotoRow({
  photo,
  index,
  current,
  focused,
  onOpen,
}: {
  photo: TimelinePhoto;
  index: number;
  current: boolean;
  focused: boolean;
  onOpen: () => void;
}) {
  return (
    <li
      id={`photo-${photo.id}`}
      data-qa="portal-photo-row"
      data-focused={focused ? 'true' : undefined}
      className={focused ? 'animate-portal-focus' : undefined}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        data-qa="portal-photo-open"
        className="bg-muted-soft block w-full overflow-hidden rounded-lg"
      >
        {/* Same-origin, cookie-authenticated BFF media URL: next/image's
            optimizer would drop the session, so a plain <img> is correct
            (same call as the staff Progress tab). */}
        <img
          src={photo.mediaUrl}
          alt={photoAlt(photo)}
          width={800}
          height={600}
          loading={index < EAGER_IMAGES ? 'eager' : 'lazy'}
          decoding="async"
          className="aspect-[4/3] w-full object-cover"
          data-qa="portal-photo-img"
        />
      </button>
      <div className="mt-2 flex items-center gap-3">
        {photo.phaseName !== null ? (
          <Badge
            variant={current ? 'success' : 'muted'}
            size="lg"
            aria-label={`Phase: ${photo.phaseName}${current ? ', current phase' : ''}`}
            data-qa="portal-phase-chip"
          >
            {photo.phaseName}
          </Badge>
        ) : null}
        <time dateTime={photo.takenAt} className="text-muted-foreground text-base" data-qa="portal-photo-date">
          {formatDay(photo.takenAt)}
        </time>
      </div>
    </li>
  );
}

export function PortalTimeline({
  photos,
  isLoading,
  isError,
  onRetry,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onOpenPhoto,
  focusedPhotoId = null,
}: PortalTimelineProps) {
  if (isLoading) return <TimelineSkeleton />;

  if (isError) {
    return (
      <div
        role="alert"
        data-qa="portal-load-error"
        className="text-destructive bg-destructive-soft flex items-center gap-3 rounded-lg px-4 py-3 text-base"
      >
        <span className="flex-1">We could not load your photos.</span>
        <Button type="button" variant="outline" size="lg" className="min-h-11" onClick={onRetry} data-qa="portal-load-retry">
          <LuRefreshCw className="size-4" aria-hidden="true" /> Try again
        </Button>
      </div>
    );
  }

  if (photos.length === 0) {
    return (
      <div data-qa="portal-empty">
        <Empty
          media={<LuCamera className="size-full" />}
          mediaVariant="icon"
          title="First photos coming soon"
          description="We'll notify you when the first photo lands."
        />
      </div>
    );
  }

  const newest = photos[0];
  const currentPhaseId = newest?.phaseId ?? null;
  const groups = groupByMonth(photos);
  let index = 0;

  return (
    <div aria-live="polite" data-qa="portal-timeline" className="space-y-8">
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`month-${group.key}`} data-qa="portal-month">
          <h2 id={`month-${group.key}`} className="text-muted-foreground mb-3 text-base font-semibold">
            {group.label}
          </h2>
          <ol className="space-y-6">
            {group.photos.map((photo) => {
              const row = (
                <PhotoRow
                  key={photo.id}
                  photo={photo}
                  index={index}
                  current={currentPhaseId !== null && photo.phaseId === currentPhaseId}
                  focused={photo.id === focusedPhotoId}
                  onOpen={() => onOpenPhoto(photo.id)}
                />
              );
              index += 1;
              return row;
            })}
          </ol>
        </section>
      ))}
      {hasMore ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-h-11 w-full"
          onClick={onLoadMore}
          disabled={isLoadingMore}
          data-qa="portal-load-more"
        >
          {isLoadingMore ? 'Loading...' : 'Show earlier photos'}
        </Button>
      ) : null}
    </div>
  );
}
