'use client';

// PhotoLightbox: a photo opened full-screen, with previous/next, swipe,
// arrow keys and pinch/double-tap zoom. Used for tapping a card and for the
// `?photo=<id>` push deep link. Mirrors the staff SitePhotoViewer so a phone
// behaves the same in both products (h-dvh, 44px controls, safe-area bottom).
//
// `PhotoLightboxPanel` is the content, split from the Dialog wrapper so it
// renders in a static-markup test (the library Dialog portals into <body>).
import { useEffect } from 'react';

import { Dialog, IconButton } from '@paalstack/react-ui';
import { LuChevronLeft, LuChevronRight, LuX } from '@paalstack/react-icons/lu';

import { ZoomableImage } from '@/components/site/ZoomableImage';
import type { TimelinePhoto } from '@/hooks/queries/customer-portal';
import { constructionStageLabel } from '@/lib/labels';

import { formatDay, photoAlt } from './portal-format';

export type PhotoLightboxProps = {
  /** The loaded feed, newest first - the lightbox pages through it. */
  photos: readonly TimelinePhoto[];
  openPhotoId: string | null;
  onSelect: (photoId: string) => void;
  onClose: () => void;
};

export function PhotoLightbox({ photos, openPhotoId, onSelect, onClose }: PhotoLightboxProps) {
  const index = openPhotoId === null ? -1 : photos.findIndex((p) => p.id === openPhotoId);
  const photo = index === -1 ? null : (photos[index] as TimelinePhoto);
  const previous = index > 0 ? (photos[index - 1] as TimelinePhoto) : null;
  const next =
    index !== -1 && index < photos.length - 1 ? (photos[index + 1] as TimelinePhoto) : null;

  useEffect(() => {
    if (photo === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowLeft' && previous !== null) {
        event.preventDefault();
        onSelect(previous.id);
      } else if (event.key === 'ArrowRight' && next !== null) {
        event.preventDefault();
        onSelect(next.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [photo, previous, next, onSelect]);

  if (photo === null) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      trigger={null}
      contentClassName="sm:max-w-none max-w-none w-screen h-dvh p-0 bg-background/70 backdrop-blur-2xl backdrop-saturate-150"
      dialogTitleProps={{ className: 'sr-only' }}
      dialogContentProps={{ showCloseButton: false }}
      header={{ title: photo.phaseName ?? 'Construction photo', className: 'sr-only' }}
    >
      <PhotoLightboxPanel
        photo={photo}
        position={index + 1}
        total={photos.length}
        onClose={onClose}
        onPrevious={previous === null ? null : () => onSelect(previous.id)}
        onNext={next === null ? null : () => onSelect(next.id)}
      />
    </Dialog>
  );
}

export function PhotoLightboxPanel({
  photo,
  position,
  total,
  onClose,
  onPrevious,
  onNext,
}: {
  photo: TimelinePhoto;
  position: number;
  total: number;
  onClose: () => void;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const note = photo.caption.trim();
  return (
    <div className="relative flex h-dvh w-full flex-col" data-qa="portal-lightbox">
      <div className="relative z-10 flex items-center justify-between gap-2 px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
        <p
          className="text-muted-foreground pl-2 text-sm tabular-nums"
          data-qa="portal-lightbox-count"
        >
          {position} of {total}
        </p>
        <div className="flex items-center gap-1">
          {/* Placeholders keep Close from shifting under the thumb at the
              first/last photo; they are not rendered as controls. */}
          {onPrevious !== null ? (
            <IconButton
              type="button"
              variant="ghost"
              className="size-11"
              icon={<LuChevronLeft className="size-5" aria-hidden="true" />}
              aria-label="Previous photo"
              onClick={onPrevious}
              data-qa="portal-lightbox-previous"
            />
          ) : (
            <span className="size-11" aria-hidden="true" />
          )}
          {onNext !== null ? (
            <IconButton
              type="button"
              variant="ghost"
              className="size-11"
              icon={<LuChevronRight className="size-5" aria-hidden="true" />}
              aria-label="Next photo"
              onClick={onNext}
              data-qa="portal-lightbox-next"
            />
          ) : (
            <span className="size-11" aria-hidden="true" />
          )}
          <IconButton
            type="button"
            variant="ghost"
            className="size-11"
            icon={<LuX className="size-5" aria-hidden="true" />}
            aria-label="Close photo"
            onClick={onClose}
            data-qa="portal-lightbox-close"
          />
        </div>
      </div>

      {/* Keyed so zoom resets on every photo; swipe only fires at 1x. */}
      <ZoomableImage
        key={photo.id}
        src={photo.mediaUrl}
        alt={photoAlt(photo)}
        onSwipe={(direction) => {
          if (direction === 'next') onNext?.();
          else onPrevious?.();
        }}
      />

      <div className="border-border bg-background/90 border-t px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        {note.length > 0 ? (
          <p
            className="portal-display text-foreground text-lg leading-snug"
            data-qa="portal-lightbox-note"
          >
            {note}
          </p>
        ) : null}
        <p className="text-muted-foreground mt-1 text-sm">
          <time dateTime={photo.takenAt}>{formatDay(photo.takenAt)}</time>
          {photo.phaseName !== null ? ` · ${photo.phaseName}` : ''}
          {photo.stage !== null && constructionStageLabel(photo.stage) !== photo.phaseName
            ? ` · ${constructionStageLabel(photo.stage)}`
            : ''}
        </p>
      </div>
    </div>
  );
}
