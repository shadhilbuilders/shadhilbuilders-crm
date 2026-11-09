'use client';

// SitePhotoViewer (2026-11-08): full-screen photo dialog.
//
// Presentational: the open photo and its neighbours arrive as props, so the
// keyboard contract and the prev/next rules are testable without a query client.
//
// The bottom bar carries the note, the FULL date and the uploader, because this
// is where someone looks when they need to be sure what they are looking at.
// The image is zoomable (buttons, wheel, pinch, double-tap) and pannable.
import { useEffect } from 'react';

import { Dialog, IconButton } from '@paalstack/react-ui';
import { LuChevronLeft, LuChevronRight, LuX } from '@paalstack/react-icons/lu';

import { formatDay } from '@/components/portal/portal-format';
import type { TimelinePhoto } from '@/hooks/queries/customer-progress';

import { ZoomableImage } from './ZoomableImage';

/** `4 November 2026, 4:12 pm` - the unambiguous reading. */
export function fullCaptureTime(iso: string, timeZone = 'Asia/Kolkata'): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  });
}

export type SitePhotoViewerProps = {
  photo: TimelinePhoto | null;
  unitNumber: string;
  onClose: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
};

export function SitePhotoViewer({
  photo,
  unitNumber,
  onClose,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: SitePhotoViewerProps) {
  // Arrow keys and Escape. Registered only while a photo is open, and removed on
  // close so the page's own scrolling keys are untouched.
  useEffect(() => {
    if (photo === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key === 'ArrowLeft' && hasPrevious) {
        event.preventDefault();
        onPrevious();
        return;
      }
      if (event.key === 'ArrowRight' && hasNext) {
        event.preventDefault();
        onNext();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [photo, hasPrevious, hasNext, onClose, onPrevious, onNext]);

  if (photo === null) return null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      trigger={null}
      contentClassName="sm:max-w-none max-w-none w-screen h-dvh p-0 bg-background/40 backdrop-blur-2xl backdrop-saturate-150"
      dialogTitleProps={{ className: 'sr-only' }}
      // The panel draws its own 44px close control; the library's 32px one
      // would sit on top of it.
      dialogContentProps={{ showCloseButton: false }}
      header={{ title: `Unit ${unitNumber} photo`, className: 'sr-only' }}
    >
      <SitePhotoViewerPanel
        photo={photo}
        unitNumber={unitNumber}
        onClose={onClose}
        hasPrevious={hasPrevious}
        hasNext={hasNext}
        onPrevious={onPrevious}
        onNext={onNext}
      />
    </Dialog>
  );
}

/** The viewer's CONTENT, split out from the Dialog wrapper so it renders in a
 *  static-markup test (the library's Dialog portals into document.body). */
export function SitePhotoViewerPanel({
  photo,
  unitNumber,
  onClose,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  photo: TimelinePhoto;
  unitNumber: string;
  onClose: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const note = photo.caption.trim();
  const alt = note.length > 0 ? `Unit ${unitNumber}, "${note}"` : `Unit ${unitNumber} progress photo`;

  return (
      <div className="relative flex h-dvh w-full flex-col" data-qa="site-photo-viewer">
        <div className="relative z-10 flex items-center justify-between px-2 py-2">
          <span className="sr-only">Photo viewer</span>
          <div className="flex gap-1">
            {hasPrevious ? (
              <IconButton
                type="button"
                variant="ghost"
                className="size-11"
                icon={<LuChevronLeft className="size-5" aria-hidden="true" />}
                aria-label="Previous photo"
                onClick={onPrevious}
                data-qa="site-photo-previous"
              />
            ) : null}
            {hasNext ? (
              <IconButton
                type="button"
                variant="ghost"
                className="size-11"
                icon={<LuChevronRight className="size-5" aria-hidden="true" />}
                aria-label="Next photo"
                onClick={onNext}
                data-qa="site-photo-next"
              />
            ) : null}
          </div>
          <IconButton
            type="button"
            variant="ghost"
            className="size-11"
            icon={<LuX className="size-5" aria-hidden="true" />}
            aria-label="Close photo"
            onClick={onClose}
            data-qa="site-photo-close"
          />
        </div>

        {/* Keyed so zoom resets when moving to another photo. The image is
            clipped to this region: before, it overflowed over the header and
            swallowed taps on Back/Close. */}
        <ZoomableImage key={photo.id} src={photo.mediaUrl} alt={alt} />

        <div className="bg-background/95 border-border border-t px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
          {note.length > 0 ? (
            <p className="text-foreground text-sm leading-snug" data-qa="site-photo-note">
              {note}
            </p>
          ) : null}
          <p className="text-muted-foreground mt-1 text-xs">
            <span data-qa="site-photo-full-date">{fullCaptureTime(photo.takenAt)}</span>
            {photo.creatorName !== null ? (
              <>
                {' · '}
                <span data-qa="site-photo-uploader">{photo.creatorName}</span>
              </>
            ) : null}
            {photo.phaseName !== null ? (
              <>
                {' · '}
                <span>{photo.phaseName}</span>
              </>
            ) : null}
            <span className="sr-only">{formatDay(photo.takenAt)}</span>
          </p>
        </div>
      </div>
  );
}
