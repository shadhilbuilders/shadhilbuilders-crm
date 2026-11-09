'use client';

// PortalTimeline: the buyer's photo record, grouped by construction phase.
//
// Presentational: state comes in as props so every state is renderable (and
// testable) without a query client:
//   loading -> skeleton shaped like the ledger rows
//   empty   -> warm, forward-looking copy
//   data    -> phase sections of ledger rows (+ load more)
//
// NO ERROR STATE (2026-11-09, third pass). A failed timeline is not a failed
// panel: the hero's photo and the journey ladder are BOTH derived from it, so
// rendering an error here left the buyer reading "First photos coming soon"
// directly above "Internal Server Error". The page now owns that case and
// renders the shared PageError instead of this component at all, so the
// `isError`/`error`/`onRetry` props were removed rather than left as dead code.
//
// SHOWS EVERY LOADED PHOTO (2026-11-09). The page no longer trims the newest
// photo off the feed before handing it over - that slice existed to stop the
// hero and the first row showing the same image, but it also hid that photo
// from the record. The phase group is now the complete list of what has been
// uploaded, and the duplicate concern is handled by the page (see its
// `heroPhoto` comment). Pagination is UNCHANGED: `hasMore` / `onLoadMore`
// still drive the explicit "Show earlier photos" control.
import { Button, Empty } from '@paalstack/react-ui';
import { LuCamera } from '@paalstack/react-icons/lu';

import type { TimelinePhoto } from '@/hooks/queries/customer-portal';

import { PortalPhaseGroup } from './portal-phase-group';
import { groupByPhase } from './portal-progress';

export type PortalTimelineProps = {
  photos: readonly TimelinePhoto[];
  isLoading: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onOpenPhoto: (photoId: string) => void;
  /** Photo opened from a push deep link: gets the single motion moment. */
  focusedPhotoId?: string | null;
};

function TimelineSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading photos" data-qa="portal-skeleton">
      <div className="portal-rule-b pb-2.5">
        <div className="h-5 w-40 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="portal-hairline-b flex items-center gap-4 py-4">
          <div className="size-[4.5rem] shrink-0 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-3/5 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
            <div className="h-2.5 w-1/4 animate-pulse bg-[var(--portal-hair)] motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function PortalTimeline({
  photos,
  isLoading,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onOpenPhoto,
  focusedPhotoId = null,
}: PortalTimelineProps) {
  if (isLoading) return <TimelineSkeleton />;

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

  const groups = groupByPhase(photos);
  const newestPhaseId = photos[0]?.phaseId ?? null;
  // Prefix sums: where each group's first photo sits in the whole feed.
  const starts = groups.map((_, i) =>
    groups.slice(0, i).reduce((sum, g) => sum + g.photos.length, 0),
  );

  return (
    <div data-qa="portal-timeline">
      {/* A short status, not the whole feed: a live region around every row
          would read a full page of photos aloud on "Show earlier photos". */}
      <p role="status" className="sr-only">
        {photos.length} {photos.length === 1 ? 'photo' : 'photos'} shown
      </p>
      {groups.map((group, i) => (
        <PortalPhaseGroup
          key={group.key}
          group={group}
          current={i === 0 && newestPhaseId !== null}
          startIndex={starts[i] ?? 0}
          focusedPhotoId={focusedPhotoId}
          onOpenPhoto={onOpenPhoto}
        />
      ))}
      {hasMore ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="mt-5 min-h-11 w-full rounded-full"
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
