'use client';

// SiteCaptureView (2026-11-08): the capture screen's whole surface, presentational.
//
// One column, phone first, thumb reachable:
//   - sticky 56px header: back, unit title + project/phase, unit status badge and
//     the recorded stage,
//   - scrolling content: the summary line and the photo feed (or the empty hero),
//   - sticky bottom bar: `Take photo` (camera) + `Gallery` (the library
//     FileUpload surface).
//
// Every input arrives as a prop; `site/[unitId]/page.tsx` owns the queries, the
// queue and the file inputs. That split is what makes every state here
// renderable by `renderToStaticMarkup` in a test.
import {
  Badge,
  Button,
  FileUpload,
  FileUploadDropzone,
  FileUploadTrigger,
  IconButton,
  Spinner,
} from '@paalstack/react-ui';
import { LuCamera, LuChevronLeft, LuVideo } from '@paalstack/react-icons/lu';
import Link from 'next/link';
import type { RefObject } from 'react';

import type { TimelinePhoto } from '@/hooks/queries/customer-progress';
import { constructionStageOrUnset, inventoryStatusBadgeVariant, labelFor } from '@/lib/labels';
import {
  photoSummaryLine,
  unitPhotoState,
  unitPhotoStateBadgeVariant,
  unitPhotoStateSurface,
} from '@/lib/site-photos';

import { ProgressPhotoActions } from '@/components/inventory/ProgressPhotoActions';

import { NoteDialog, type NoteDialogProps } from './NoteDialog';
import { SiteEmptyHero } from './SiteEmptyHero';
import { SitePhotoFeed, type UploadingState } from './SitePhotoFeed';
import { SitePhotoViewer, type SitePhotoViewerProps } from './SitePhotoViewer';

export type CaptureHeaderUnit = {
  unitNumber: string;
  projectName: string;
  phaseName: string;
  status: string;
  /** Stage of the newest row that recorded one, or null. "Stage not set" when null. */
  lastRecordedStage: string | null;
  photoCount: number;
  lastPhotoAt: string | null;
  /** Shown to read-only viewers (manager/admin/owner): who owns this villa. */
  assignedEngineerName?: string | null;
};

export type SiteCaptureViewProps = {
  unit: CaptureHeaderUnit;
  /**
   * True for the ENGINEER (the only role that captures). Manager/admin/owner
   * review the same screen read-only: no camera bar, no note dialog, no photo
   * edit/delete actions. Defaults to true so existing callers are unchanged.
   */
  canCapture?: boolean;
  backHref: string;
  photos: readonly TimelinePhoto[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  uploading: readonly UploadingState[];
  onRetryUpload: (index: number) => void;
  onDiscardUpload: (index: number) => void;
  onOpenPhoto: (photoId: string) => void;
  now: Date;
  /** Hidden `<input type="file" capture="environment">` ref (camera path). */
  cameraInputRef: RefObject<HTMLInputElement | null>;
  onCameraChange: (file: File | null) => void;
  onCameraClick: () => void;
  /** Files from the library FileUpload surface (gallery / drop / empty panel). */
  onGalleryFiles: (files: File[]) => void;
  onFileReject: (file: File, message: string) => void;
  /** True while a chosen file is being converted. */
  isPreparing: boolean;
  noteDialog: NoteDialogProps;
  viewer: SitePhotoViewerProps;
  /** Announcements: "Uploading photo..." / "Photo saved." */
  announcement: string;
  /**
   * Video capture, present only while SITE_VIDEO_CAPTURE is on (read on the
   * server). Absent = the photo-only bar, byte for byte.
   */
  video?: {
    onRecord: () => void;
    /** A video picked from the gallery. */
    onFile: (file: File | null) => void;
    fileInputRef: RefObject<HTMLInputElement | null>;
  };
};

export function SiteCaptureView({
  unit,
  canCapture = true,
  backHref,
  photos,
  isLoading,
  isError,
  onRetry,
  hasMore,
  isLoadingMore,
  onLoadMore,
  uploading,
  onRetryUpload,
  onDiscardUpload,
  onOpenPhoto,
  now,
  cameraInputRef,
  onCameraChange,
  onCameraClick,
  onGalleryFiles,
  onFileReject,
  isPreparing,
  noteDialog,
  viewer,
  announcement,
  video,
}: SiteCaptureViewProps) {
  const state = unitPhotoState({ photoCount: unit.photoCount, lastPhotoAt: unit.lastPhotoAt }, now);
  const summary = photoSummaryLine(photos, now);
  const isEmpty = !isLoading && !isError && photos.length === 0 && uploading.length === 0;

  // ONE FileUpload provider wraps both the empty panel and the Gallery trigger:
  // two providers would mean two independent file states, and the dropzone would
  // be a dead surface. Validation, rejection messages, multi-select and the
  // per-file state live in the component, not in a hand-rolled guard.
  return (
    <FileUpload
      accept="image/*"
      maxFiles={8}
      maxSize={10 * 1024 * 1024}
      multiple
      dir="ltr"
      data-qa="site-file-upload"
      onFileValidate={(file) =>
        file.type.startsWith('image/') ? null : 'That file is not an image.'
      }
      onFileReject={(file, message) => onFileReject(file, message)}
      onValueChange={(files) => {
        if (files.length > 0) onGalleryFiles(files);
      }}
    >
      <div className="bg-background flex min-h-dvh flex-col" data-qa="site-capture-screen">
        {/* Sticky header: the back chevron is the only exit - no Close button.
            OPAQUE, and the inset is padded the same way AppHeader pads it.
            (2026-11-22) Both were wrong on an installed iPhone:
              - `bg-background/95` + `backdrop-blur` let the photo feed show
                through, so the bar read as a patchy smear: blurred where a
                card sat under it, plain where the white gutter did. Every
                other top bar in the app (AppHeader, GuestTopBar, the portal
                header) is opaque for exactly this reason.
              - a bare `pt-[env(safe-area-inset-top)]` left the row flush
                against the status bar and the bottom border with no air.
                The clamped `+min(2rem,...)` is the same breathing room
                AppHeader carries, one step larger: this row carries a title,
                a subtitle and two stacked badges, so it needs the air more.
                It resolves to 0 where there is no inset, so desktop and
                Android are untouched. */}
        <header className="bg-background border-border sticky top-0 z-20 border-b pt-[calc(max(0px,env(safe-area-inset-top))+min(2rem,env(safe-area-inset-top)))]">
          <div className="flex min-h-14 items-center gap-2 px-2">
            <IconButton
              as={Link}
              href={backHref}
              variant="ghost"
              className="size-11 shrink-0"
              icon={<LuChevronLeft className="size-5" aria-hidden="true" />}
              aria-label="Back to site updates"
              data-qa="site-back"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold tabular-nums">{unit.unitNumber}</p>
              <p className="text-muted-foreground truncate text-xs">
                {unit.projectName} · {unit.phaseName}
                {!canCapture ? ` · ${unit.assignedEngineerName ?? 'Unassigned'}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Badge variant={inventoryStatusBadgeVariant(unit.status)} data-qa="site-unit-status">
                {labelFor('inventory', unit.status)}
              </Badge>
              <Badge
                variant={unitPhotoStateBadgeVariant(state)}
                className={unitPhotoStateSurface(state)}
                data-qa="site-unit-stage"
                data-state={state}
              >
                {constructionStageOrUnset(unit.lastRecordedStage)}
              </Badge>
            </div>
          </div>
        </header>

        {/* `pb-28` so the sticky bar never covers the last card. */}
        <main className="flex-1 space-y-4 px-4 py-4 pb-28">
          {summary !== null ? (
            <p className="text-muted-foreground text-sm" data-qa="site-summary-line">
              {summary}
            </p>
          ) : null}

          {isEmpty && !canCapture ? (
            <p className="text-muted-foreground text-sm" data-qa="site-readonly-empty">
              No site updates have been posted for this villa yet.
            </p>
          ) : null}

          {isEmpty && canCapture ? (
            // The whole panel IS the FileUpload dropzone: a drop target on
            // desktop, the picker on a phone, one affordance instead of a button
            // above a dead dashed box.
            // The dropzone is the behaviour; the HERO is the surface. The
            // library's own dashed 2px border and padding are stripped because the
            // design deliberately avoids a dashed drop zone (it reads as dead
            // space, which is the state this panel replaced).
            <FileUploadDropzone
              data-qa="site-file-dropzone"
              className="border-0! bg-transparent! p-0! hover:bg-transparent!"
            >
              <SiteEmptyHero unitNumber={unit.unitNumber} videoEnabled={video !== undefined} />
            </FileUploadDropzone>
          ) : null}

          {isPreparing ? (
            <div
              className="text-muted-foreground flex items-center gap-2 text-sm"
              data-qa="site-preparing-photo"
              role="status"
              aria-live="polite"
            >
              <Spinner className="size-4" aria-hidden="true" /> Preparing photo...
            </div>
          ) : null}

          {photos.length > 0 || isLoading || isError || uploading.length > 0 ? (
            <SitePhotoFeed
              photos={photos}
              isLoading={isLoading}
              isError={isError}
              onRetry={onRetry}
              hasMore={hasMore}
              isLoadingMore={isLoadingMore}
              onLoadMore={onLoadMore}
              onOpenPhoto={onOpenPhoto}
              uploading={uploading}
              onRetryUpload={onRetryUpload}
              onDiscardUpload={onDiscardUpload}
              now={now}
              unitLabel={unit.unitNumber}
              renderActions={
                canCapture
                  ? (photo) => <ProgressPhotoActions photo={photo} unitId={photo.unitId} />
                  : undefined
              }
            />
          ) : null}

          {/* One polite live region for the upload states. Focus never moves. */}
          <p className="sr-only" aria-live="polite" data-qa="site-live-region">
            {announcement}
          </p>
        </main>

        {/* Sticky bar, above the safe area. Read-only viewers get no capture bar.
            Opaque for the same reason as the header: a photo scrolling under a
            95%-opaque strip ghosts through it. */}
        {canCapture ? (
          <footer className="bg-background border-border sticky bottom-0 z-20 border-t px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
            <div className="flex items-center gap-2">
              {/* The camera path is a PLAIN input: FileUploadProps does not expose
              `capture`, and without capture="environment" an iPhone shows the
              Library / Take Photo sheet and costs a tap on every photo. */}
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                data-qa="site-camera-input"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  event.target.value = ''; // allow re-picking the same file
                  onCameraChange(file);
                }}
              />
              <Button
                type="button"
                // The library's primary variant only carries `[a]:hover:bg-primary/80`,
                // so a <button> has NO hover state at all - measured identical at rest
                // and on hover. This is the flow's main action, so it gets one.
                className="hover:bg-primary/90 active:bg-primary/80 min-h-12 flex-1 text-base"
                leftIcon={<LuCamera className="size-5" aria-hidden="true" />}
                onClick={onCameraClick}
                data-qa="site-take-photo"
              >
                Take photo
              </Button>

              {video !== undefined ? (
                <>
                  <input
                    ref={video.fileInputRef}
                    type="file"
                    accept="video/mp4"
                    className="hidden"
                    data-qa="capture-video-input"
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      event.target.value = '';
                      video.onFile(file);
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    className="min-h-12 flex-1 text-base"
                    leftIcon={<LuVideo className="size-5" aria-hidden="true" />}
                    onClick={video.onRecord}
                    data-qa="capture-video"
                  >
                    Video
                  </Button>
                </>
              ) : null}

              {/* Same provider as the empty panel: one file state, one handler. */}
              <FileUploadTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-12 flex-1 text-base"
                  data-qa="site-gallery-trigger"
                >
                  Gallery
                </Button>
              </FileUploadTrigger>
            </div>
          </footer>
        ) : null}

        {canCapture ? <NoteDialog {...noteDialog} /> : null}
        <SitePhotoViewer {...viewer} />
      </div>
    </FileUpload>
  );
}
