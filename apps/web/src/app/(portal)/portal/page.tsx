'use client';

// /portal (issue #8 slice 2): the buyer's progress page. Reads `me`, then the
// timeline for the selected unit. `?photo=<id>` (the push deep link) opens
// that photo full-bleed once it has loaded.
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { PageLoading } from '@/components/shared/PageLoading';
import { PhotoLightbox } from '@/components/portal/photo-lightbox';
import { PortalLock } from '@/components/portal/portal-lock';
import { PortalPushPrompt } from '@/components/portal/portal-push-prompt';
import { PortalStageStepper } from '@/components/portal/portal-stage-stepper';
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
  const params = useSearchParams();
  const deepLinkPhotoId = params.get('photo');

  const me = useCustomerMe();
  const units = me.data?.units ?? [];
  const deepLinkUnitId = useDeepLinkUnit(deepLinkPhotoId, units.map((u) => u.unitId));

  const [chosenUnitId, setChosenUnitId] = useState<string | null>(null);
  const selectedUnitId = chosenUnitId ?? deepLinkUnitId ?? units[0]?.unitId ?? null;
  const selectedUnit = units.find((u) => u.unitId === selectedUnitId) ?? null;

  const timeline = useCustomerTimeline(selectedUnitId);
  const photos = useMemo(
    () => (timeline.data?.pages ?? []).flatMap((page) => page.photos),
    [timeline.data],
  );

  // The lightbox owns its own open state once the deep link has resolved;
  // closing it clears the param so a refresh does not reopen the photo.
  const [openPhotoId, setOpenPhotoId] = useState<string | null>(null);
  useEffect(() => {
    if (deepLinkPhotoId !== null && photos.some((p) => p.id === deepLinkPhotoId)) {
      setOpenPhotoId(deepLinkPhotoId);
    }
  }, [deepLinkPhotoId, photos]);
  const openPhoto = photos.find((p) => p.id === openPhotoId) ?? null;

  if (me.isPending) return <PageLoading content="Loading your home..." />;

  const lock = notLinkedInfo(me.error);
  if (lock !== null) return <PortalLock reason="not-linked" officePhone={lock.officePhone} />;
  if (me.isError) {
    return (
      <PortalTimeline
        photos={[]}
        isLoading={false}
        isError
        onRetry={() => void me.refetch()}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={() => undefined}
        onOpenPhoto={() => undefined}
      />
    );
  }
  if (units.length === 0) return <PortalLock reason="no-units" />;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-muted-foreground text-base">Hello, {me.data?.customerName}</p>
        <h1 className="text-2xl font-semibold" data-qa="portal-unit-heading">
          {selectedUnit ? `${selectedUnit.unitNumber}, ${selectedUnit.projectName}` : 'Your home'}
        </h1>
      </div>
      <UnitSwitcher units={units} selectedUnitId={selectedUnitId} onSelect={setChosenUnitId} />
      {/* The only surface a buyer ever sees, so the push opt-in lives here:
          the staff shell's PushEnablePrompt is unreachable for a CUSTOMER
          (AuthenticatedShell bounces them to /portal). Without this the
          notifier has no subscription to deliver to. Renders nothing when
          unsupported, already enabled, or previously dismissed. */}
      <PortalPushPrompt />
      {/* The stage line sits ABOVE the feed: "where is my house up to" is the
          buyer's first question, and the newest photo answers it. */}
      <PortalStageStepper currentStage={photos[0]?.stage ?? null} />
      <PortalTimeline
        photos={photos}
        isLoading={timeline.isPending}
        isError={timeline.isError}
        onRetry={() => void timeline.refetch()}
        hasMore={timeline.hasNextPage}
        isLoadingMore={timeline.isFetchingNextPage}
        onLoadMore={() => void timeline.fetchNextPage()}
        onOpenPhoto={setOpenPhotoId}
        focusedPhotoId={deepLinkPhotoId}
      />
      <PhotoLightbox
        photo={openPhoto}
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
    <Suspense fallback={<PageLoading content="Loading your home..." />}>
      <PortalProgress />
    </Suspense>
  );
}
