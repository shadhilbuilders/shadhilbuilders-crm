'use client';

// /portal (issue #8 slice 2): the buyer's record of their home.
// Reads `me`, then the timeline for the selected unit. `?photo=<id>` (the push
// deep link) opens that photo full-bleed once it has loaded.
//
// REDESIGN (2026-11-09, second pass). The page is now a document, not a
// dashboard:
//   1. The newest photo appears ONCE, as the hero plate. The ledger below it
//      lists the entries before it, so the same image is never shown twice
//      (the previous build rendered it in both places).
//   2. The nine-row stepper is gone; the journey is a 34px ladder in a status
//      band beside the handover figures. The photos now start inside the first
//      screen instead of below it.
//   3. "Stage 2 of 9" is printed once, in the hero's spec figure. The journey
//      shows the numeral and the ladder; the phase header names the phase.
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { PhotoLightbox } from '@/components/portal/photo-lightbox';
import { PageError } from '@/components/shared/PageError';
import { PortalUnitRecord } from '@/components/portal/portal-unit-record';
import { PortalHandoverCard } from '@/components/portal/portal-handover-card';
import { PortalHero } from '@/components/portal/portal-hero';
import { PortalJourney } from '@/components/portal/portal-journey';
import { PortalLock } from '@/components/portal/portal-lock';
import { PortalMilestones } from '@/components/portal/portal-milestones';
import { PortalPageSkeleton } from '@/components/portal/portal-skeleton';
import { PortalPushPrompt } from '@/components/portal/portal-push-prompt';
import { PortalStageFilter } from '@/components/portal/portal-stage-filter';
import { PortalTimeline } from '@/components/portal/portal-timeline';
import { UnitSwitcher } from '@/components/portal/unit-switcher';
import {
  notLinkedInfo,
  useCustomerMe,
  useCustomerStageCounts,
  useCustomerTimeline,
  useDeepLinkUnit,
} from '@/hooks/queries/customer-portal';
import {
  effectiveStageFilter,
  stageChips,
  totalItems,
  type StageFilter,
} from '@/lib/portal-stages';

function PortalProgress() {
  const router = useRouter();
  const [now] = useState(() => Date.now());
  const params = useSearchParams();
  const deepLinkPhotoId = params.get('photo');

  const me = useCustomerMe();
  const units = me.data?.units ?? [];
  const deepLinkUnitId = useDeepLinkUnit(
    deepLinkPhotoId,
    units.map((u) => u.unitId),
  );

  const [chosenUnitId, setChosenUnitId] = useState<string | null>(null);
  const selectedUnitId = chosenUnitId ?? deepLinkUnitId ?? units[0]?.unitId ?? null;
  const selectedUnit = units.find((u) => u.unitId === selectedUnitId) ?? null;

  // ── Stage grouping (2026-11-25) ───────────────────────────────────────────
  // The chips carry the server's per-stage totals and narrow the feed through the
  // API, so the count on a chip and the rows under it cannot disagree and every
  // stage is its own cursor chain. A deep link overrides the chip until it has
  // been opened: the notified photo is very likely not in a narrowed list, and
  // the one thing that message was for must not be filtered away.
  const [chosenStage, setChosenStage] = useState<StageFilter>('all');
  const stageFilter = effectiveStageFilter(chosenStage, deepLinkPhotoId);
  const stageCounts = useCustomerStageCounts(selectedUnitId);

  const timeline = useCustomerTimeline(selectedUnitId, stageFilter);
  const photos = useMemo(
    () => (timeline.data?.pages ?? []).flatMap((page) => page.photos),
    [timeline.data],
  );

  // The lightbox pages through the whole feed, including the hero's photo.
  const [openPhotoId, setOpenPhotoId] = useState<string | null>(null);
  useEffect(() => {
    if (deepLinkPhotoId !== null && photos.some((p) => p.id === deepLinkPhotoId)) {
      setOpenPhotoId(deepLinkPhotoId);
    }
  }, [deepLinkPhotoId, photos]);
  const openPhoto = photos.find((p) => p.id === openPhotoId) ?? null;

  const heroPhoto = photos[0] ?? null;

  // The list shows EVERY loaded photo, including the one in the hero - the
  // record is the point, and hiding its newest entry made the phase group
  // incomplete. The hero is a plate, not a duplicate: it sits above the ledger
  // with its own caption, so the same image in two places reads as "the latest"
  // and "the first row of the record", not as a mistake.
  //
  // The hero already carries the "first photos coming soon" placeholder, so the
  // ledger's own empty state would say it twice.
  // Also true when the COUNTS say there is something, even if the chosen stage
  // has none (2026-11-25). Without the counts term, picking a stage that holds no
  // items hid the whole section - chips included - so the buyer had no way back
  // to All and saw a page that simply lost their photos.
  const showTimeline = timeline.isPending || photos.length > 0 || totalItems(stageCounts.data) > 0;

  if (me.isPending) return <PortalPageSkeleton />;

  const lock = notLinkedInfo(me.error);
  if (lock !== null) return <PortalLock reason="not-linked" officePhone={lock.officePhone} />;
  if (me.isError) {
    // We could not read the buyer's own record, so there is nothing on this
    // page worth showing. Direct, not routed through the timeline.
    return (
      <div data-qa="portal-load-error">
        <PageError
          error={me.error instanceof Error ? me.error : new Error('Could not load your portal')}
          onRefresh={() => void me.refetch()}
          logToConsole={false}
          showErrorMessage={false}
        />
      </div>
    );
  }
  if (units.length === 0) return <PortalLock reason="no-units" />;

  // A FAILED TIMELINE REPLACES THE PAGE, not a panel inside it.
  //
  // Regression (2026-11-09): rendering this inside the timeline slot put a 500
  // screen under a hero whose photo was empty, so the buyer read "First photos
  // coming soon" directly above "Internal Server Error" - two contradicting
  // statements about the same data. The hero's plate and the journey ladder are
  // both derived from the timeline, so neither is truthful when it fails. The
  // whole record is replaced, and the shared PageError owns the recovery path.
  if (timeline.isError) {
    return (
      <div data-qa="portal-load-error">
        <PageError
          error={
            timeline.error instanceof Error
              ? timeline.error
              : new Error('Could not load progress photos')
          }
          onRefresh={() => void timeline.refetch()}
          logToConsole={false}
          showErrorMessage={false}
        />
      </div>
    );
  }

  return (
    <div>
      <PortalHero
        customerName={me.data?.customerName ?? ''}
        unitNumber={selectedUnit?.unitNumber ?? ''}
        projectName={selectedUnit?.projectName ?? ''}
        latest={heroPhoto}
        isLoading={timeline.isPending}
        onOpenPhoto={setOpenPhotoId}
        now={now}
        photoCount={photos.length}
      >
        {/* Full-width band between the record head and the photo plate: the
            journey describes the UNIT, so it cannot sit in a column next to a
            card about the last handover, behind a photo it is not about. */}
        <PortalJourney
          currentStage={heroPhoto?.stage ?? null}
          latestTakenAt={heroPhoto?.takenAt ?? null}
          now={now}
        />
      </PortalHero>

      <UnitSwitcher units={units} selectedUnitId={selectedUnitId} onSelect={setChosenUnitId} />

      {/* The unit record + what the buyer owes (2026-11-09). The component
          lays its two halves out side by side itself, so this wrapper is just
          the vertical rhythm - a two-column grid here would have wrapped a
          single child for no reason. */}
      {selectedUnit !== null ? (
        <div className="py-7">
          <PortalUnitRecord unit={selectedUnit} />
        </div>
      ) : null}

      {/* Handover date, then the milestone ladder (2026-11-10). Two bands, in
          reading order: "when do I get the keys", then "what is between now and
          then". The date band renders nothing without a date; the ladder
          renders nothing without milestones, so an empty project shows neither
          and the page never opens a gap. */}
      {selectedUnit !== null && selectedUnit.expectedHandoverDate !== null ? (
        <div className="pt-6">
          <PortalHandoverCard expectedHandoverDate={selectedUnit.expectedHandoverDate} now={now} />
        </div>
      ) : null}

      {selectedUnit !== null && selectedUnit.milestones.length > 0 ? (
        <div className="pb-6">
          <PortalMilestones milestones={selectedUnit.milestones} now={now} />
        </div>
      ) : null}

      {/* The only surface a buyer ever sees, so the push opt-in lives here:
          the staff shell's PushEnablePrompt is unreachable for a CUSTOMER
          (AuthenticatedShell bounces them to /portal). Without this the
          notifier has no subscription to deliver to. Renders nothing when
          unsupported, already enabled, or previously dismissed. */}
      <PortalPushPrompt />

      {showTimeline ? (
        <div className="pt-2">
          <PortalStageFilter
            counts={stageCounts.data}
            value={stageFilter}
            onChange={setChosenStage}
          />
          <PortalTimeline
            photos={photos}
            filteredStageLabel={
              stageFilter === 'all'
                ? null
                : (stageChips(stageCounts.data).find((c) => c.value === stageFilter)?.label ?? null)
            }
            isLoading={timeline.isPending}
            hasMore={timeline.hasNextPage}
            isLoadingMore={timeline.isFetchingNextPage}
            onLoadMore={() => void timeline.fetchNextPage()}
            onOpenPhoto={setOpenPhotoId}
            focusedPhotoId={deepLinkPhotoId}
          />
        </div>
      ) : null}

      <PhotoLightbox
        photos={photos}
        openPhotoId={openPhoto?.id ?? null}
        onSelect={setOpenPhotoId}
        onClose={() => {
          setOpenPhotoId(null);
          if (deepLinkPhotoId !== null) router.replace('/portal');
        }}
      />
    </div>
  );
}

export default function PortalPage() {
  // useSearchParams needs a Suspense boundary for static prerender.
  return (
    <Suspense fallback={<PortalPageSkeleton />}>
      <PortalProgress />
    </Suspense>
  );
}
