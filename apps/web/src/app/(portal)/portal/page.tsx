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
import { PortalHandoverCard } from '@/components/portal/portal-handover-card';
import { PortalHero } from '@/components/portal/portal-hero';
import { PortalJourney } from '@/components/portal/portal-journey';
import { PortalLock } from '@/components/portal/portal-lock';
import { PortalPageSkeleton } from '@/components/portal/portal-skeleton';
import { PortalPushPrompt } from '@/components/portal/portal-push-prompt';
import { PortalTimeline } from '@/components/portal/portal-timeline';
import { UnitSwitcher } from '@/components/portal/unit-switcher';
import {
  notLinkedInfo,
  useCustomerMe,
  useCustomerTimeline,
  useDeepLinkUnit,
} from '@/hooks/queries/customer-portal';

function PortalProgress() {
  const router = useRouter();
  const [now] = useState(() => Date.now());
  const params = useSearchParams();
  const deepLinkPhotoId = params.get('photo');

  const me = useCustomerMe();
  const units = me.data?.units ?? [];
  const deepLinkUnitId = useDeepLinkUnit(
    deepLinkPhotoId,
    units.map((u) => u.unitId)
  );

  const [chosenUnitId, setChosenUnitId] = useState<string | null>(null);
  const selectedUnitId = chosenUnitId ?? deepLinkUnitId ?? units[0]?.unitId ?? null;
  const selectedUnit = units.find((u) => u.unitId === selectedUnitId) ?? null;

  const timeline = useCustomerTimeline(selectedUnitId);
  const photos = useMemo(
    () => (timeline.data?.pages ?? []).flatMap((page) => page.photos),
    [timeline.data]
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
  const showTimeline = timeline.isPending || photos.length > 0;

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
          error={timeline.error instanceof Error ? timeline.error : new Error('Could not load progress photos')}
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

      {/* Handover figures: a full-width band of spec figures under the record,
          on the same edges as every other rule on the page. */}
      {selectedUnit !== null ? (
        <div className="py-6">
          <PortalHandoverCard
            expectedHandoverDate={selectedUnit.expectedHandoverDate}
            milestones={selectedUnit.milestones}
            now={now}
          />
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
          <PortalTimeline
            photos={photos}
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
