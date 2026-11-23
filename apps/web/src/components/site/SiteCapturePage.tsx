'use client';

// /site/[unitId] (2026-11-08): the capture screen for one villa.
//
// ROUTE, NOT A SHEET. A sheet is a sales surface. A site engineer works on a
// phone, gets interrupted, and the browser unloads backgrounded tabs; a modal
// loses its state when that happens, a URL does not, and it can be shared over
// WhatsApp ("shoot B-101 today").
//
// The flow is three taps: pick the unit (on /site) -> shoot the photo -> type one
// line. Everything else is metadata.
//
// State machine:
//   idle -> preparing -> note-sheet-open -> uploading -> saved
//                                           ↘ failed (retry in place)
//
// Uploads are SEQUENTIAL, one POST per photo in pick order. Six parallel
// multipart bodies over site signal all time out together; a queue where a failed
// item can be retried without re-sending the ones that already landed is the only
// version that survives a bad connection.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { toast } from '@paalstack/react-ui';

import { useOnlineStatus } from '@/hooks/use-online-status';
import { useUnit } from '@/hooks/queries/inventory';
import {
  isForbidden,
  useUnitPhotos,
  useUploadUnitPhoto,
  type UploadPhotoInput,
} from '@/hooks/queries/customer-progress';
import { projectHref } from '@/lib/nav';
import { videoErrorMessage } from '@/lib/site-video/errors';
import { makePoster } from '@/lib/site-video/poster';
import type { Clip } from '@/lib/site-video/recorder-machine';
import { browserPrepareDeps, prepareVideoFile } from '@/lib/site-video/prepare-file';
import { prepareProgressPhoto, prepareErrorMessage, type PreparedPhoto } from '@/lib/photo-prep';
import { canCaptureSitePhotos, canViewSiteUpdates, useSessionUser } from '@/lib/session';
import { QUICK_NOTE_LABELS, toggleNoteLine } from '@/lib/site-photos';
import { useOrgSlug, useProjectSlug } from '@/lib/tenant-context';

import { SiteCaptureView } from '@/components/site/SiteCaptureView';
import { SiteRecorder } from '@/components/site/SiteRecorder';
import { MAX_NOTE_PHOTOS, type NoteAddSource } from '@/components/site/NoteDialog';
import type { UploadingState } from '@/components/site/SitePhotoFeed';

/** One photo in the batch, with its own upload state. */
type QueueItem = {
  /** Stable per-photo id: indexes shift when a tile is removed. */
  id: string;
  prepared: PreparedPhoto;
  /** Data URL of the prepared bytes - the blob that will actually upload. */
  previewUrl: string;
  status: 'ready' | 'uploading' | 'saved' | 'failed';
};

let captureSeq = 0;

function previewUrlFor(prepared: PreparedPhoto): string {
  return `data:${prepared.mimeType};base64,${prepared.base64}`;
}

/** The queue item shape the dialog renders as an `Attachment`. */
function toAttachment(item: QueueItem) {
  return {
    id: item.id,
    previewUrl: item.previewUrl,
    filename: item.prepared.filename,
    bytes: item.prepared.byteLength,
    status: item.status,
  };
}

export interface SiteCapturePageProps {
  /** Server-read `SITE_VIDEO_CAPTURE`. A client component cannot read process.env. */
  videoEnabled: boolean;
}

export function SiteCapturePage({ videoEnabled }: SiteCapturePageProps) {
  const params = useParams<{ unitId: string }>();
  const unitId = typeof params?.unitId === 'string' ? params.unitId : '';
  const router = useRouter();
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();
  const { user, isPending: sessionPending } = useSessionUser();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const unitQuery = useUnit(unitId.length > 0 ? unitId : null);
  const photosQuery = useUnitPhotos(unitId.length > 0 ? unitId : null);
  const upload = useUploadUnitPhoto(unitId);
  const isOnline = useOnlineStatus();

  const photos = useMemo(
    () => (photosQuery.data?.pages ?? []).flatMap((page) => page.photos),
    [photosQuery.data],
  );

  // Captured once per mount so the relative phrases do not flicker between
  // renders. A re-mount refreshes it.
  const [now] = useState(() => new Date());
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  // ── Capture state ────────────────────────────────────────────────────────
  const [preparing, setPreparing] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [stage, setStage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [openPhotoId, setOpenPhotoId] = useState<string | null>(null);

  // ── Video (only wired while SITE_VIDEO_CAPTURE is on) ────────────────────
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [pickedClip, setPickedClip] = useState<Clip | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);

  /** A video chosen from the gallery: validated here, reviewed in the recorder sheet. */
  async function pickVideoFile(file: File | null): Promise<void> {
    if (file === null) return;
    setPreparing(true);
    try {
      const clip = await prepareVideoFile(
        file,
        browserPrepareDeps((video) => makePoster(video)),
      );
      setPickedClip(clip);
      setRecorderOpen(true);
    } catch (err) {
      toast.error(videoErrorMessage(err));
    } finally {
      setPreparing(false);
    }
  }

  // ── Redirects ────────────────────────────────────────────────────────────
  // Wrong role: they are not forbidden, they are in the wrong place. Viewers
  // are ENGINEER (captures) + MANAGER/ADMIN/OWNER (read-only); everyone else
  // goes to the dashboard (the sales grid is not their destination either).
  useEffect(() => {
    if (mounted && !sessionPending && user !== null && !canViewSiteUpdates(user.role)) {
      router.replace(projectHref(orgSlug, projectSlug, '/dashboard'));
    }
  }, [mounted, sessionPending, user, router, orgSlug, projectSlug]);

  // 403 from the timeline, or a unit that is not there: the documented contract is
  // that a non-member sees nothing, and one honest sentence is the whole
  // response - never a blank screen.
  //
  // The fallback is the SITE home, not `/inventory`: the only people who reach
  // this screen are site staff, and the sales grid is a surface they must never
  // land on - not even as the place a failed request dumps them.
  useEffect(() => {
    if (isForbidden(photosQuery.error)) {
      toast.error("You are not on this project's team.");
      router.replace(projectHref(orgSlug, projectSlug, '/site'));
    }
  }, [photosQuery.error, router, orgSlug, projectSlug]);

  // ── Preparing (Slice 15c) ────────────────────────────────────────────────
  /**
   * Convert picked files and ADD them to the note.
   *
   * Two entry points, one behaviour: the sticky bar's camera/gallery (starting a
   * new note) and the dialog's own Camera/Gallery tiles (adding to the note that
   * is already open). Picks can happen any number of times and still save as one
   * note - or be saved in separate passes, whichever the engineer does.
   */
  async function addToNote(files: File[], from: NoteAddSource): Promise<void> {
    if (files.length === 0) return;
    // The sticky bar may open a fresh note; the dialog adds to the open one.
    const isFreshNote = !noteOpen;
    const alreadyIn = isFreshNote ? 0 : queue.length;
    if (alreadyIn + files.length > MAX_NOTE_PHOTOS) {
      toast.error(`Up to ${MAX_NOTE_PHOTOS} photos per note.`);
      return;
    }
    setPreparing(true);
    try {
      // Prepare EVERY file first. If any fails, say which and add none of them;
      // a partial batch is a mess to explain later. `Promise.all` is safe here
      // precisely because nothing has been sent yet.
      const prepared = await Promise.all(
        files.map((file) => prepareProgressPhoto(file, { source: from })),
      );
      setQueue((current) => {
        // A fresh note starts clean: the stage defaults to the unit's current
        // one (set below, outside this updater, so it never runs twice).
        const base = isFreshNote ? [] : current.filter((item) => item.status !== 'saved');
        return [
          ...base,
          ...prepared.map((p) => ({
            id: `capture-${(captureSeq += 1)}`,
            prepared: p,
            previewUrl: previewUrlFor(p),
            status: 'ready' as const,
          })),
        ];
      });
      if (isFreshNote) {
        // The unit's current stage is a sensible starting point; NOT_STARTED is
        // never invented when no photo has recorded one.
        setStage(unitQuery.data?.lastRecordedStage ?? null);
      }
      setNoteOpen(true);
    } catch (err) {
      // One plain sentence, nothing added: no row, no blob, no half state.
      toast.error(prepareErrorMessage(err));
    } finally {
      setPreparing(false);
    }
  }

  // ── Saving (sequential) ──────────────────────────────────────────────────
  async function saveBatch(): Promise<void> {
    const trimmed = note.trim();
    const caption = trimmed.length > 0 ? trimmed : undefined;
    const chosenStage = stage ?? undefined;
    const phaseId = unitQuery.data?.phaseId;

    if (phaseId === undefined) {
      toast.error('This unit has no phase yet, so a photo cannot be filed against it.');
      return;
    }

    // Anything that already landed stays; only what is left gets sent, so a
    // second Save in the same dialog is a no-op instead of a duplicate row.
    const pending = queue.filter((item) => item.status === 'ready' || item.status === 'failed');
    if (pending.length === 0) return;

    setAnnouncement('Uploading photo...');

    let savedCount = 0;
    let failed = false;

    for (let i = 0; i < queue.length; i += 1) {
      const item = queue[i];
      if (item === undefined || item.status === 'saved') continue;

      setQueue((current) =>
        current.map((q, index) => (index === i ? { ...q, status: 'uploading' } : q)),
      );

      const input: UploadPhotoInput = {
        phaseId,
        base64: item.prepared.base64,
        mimeType: item.prepared.mimeType,
        filename: item.prepared.filename,
        takenAt: item.prepared.takenAt,
        clientDeviceHint: item.prepared.source,
        ...(caption !== undefined ? { caption } : {}),
        ...(chosenStage !== undefined ? { stage: chosenStage as UploadPhotoInput['stage'] } : {}),
      };

      try {
        // Sequential by design: the next POST must not start until this one
        // resolves (six parallel multipart bodies over site signal all time out
        // together).
        await upload.mutateAsync(input);
        savedCount += 1;
        setQueue((current) =>
          current.map((q, index) => (index === i ? { ...q, status: 'saved' } : q)),
        );
      } catch {
        failed = true;
        setQueue((current) =>
          current.map((q, index) => (index === i ? { ...q, status: 'failed' } : q)),
        );
        break;
      }
    }

    if (failed) {
      // The dialog stays OPEN with the failed tile marked "Not saved", so the
      // engineer can retry in place instead of hunting the note back down.
      setAnnouncement('');
      toast.error('That photo did not upload. Nothing was saved.');
      return;
    }
    if (savedCount > 0) {
      toast.success(savedCount > 1 ? `${savedCount} photos saved.` : 'Photo saved.');
      setAnnouncement('Photo saved.');
    }
    // Everything landed: close the dialog and clear the batch so the next
    // capture starts clean.
    setNoteOpen(false);
    setNote('');
    setStage(null);
    setQueue([]);
  }

  // ── Discarding a draft (2026-11-09) ──────────────────────────────────────
  /**
   * "Discard" means the draft never existed.
   *
   * Nothing has been sent at this point: photos are prepared and held in memory
   * until `saveBatch` POSTs them, so dropping the queue IS the whole undo. There
   * is no server row to delete and no request to make - which is also why this
   * is synchronous and cannot fail.
   *
   * The note and the stage are part of the same draft and go with it; leaving
   * them behind made Discard look broken, because the typed line came back on
   * the next capture attached to different photos.
   */
  function discardDraft(): void {
    setQueue([]);
    setNote('');
    setStage(null);
    setNoteOpen(false);
  }

  // ── Derived view props ───────────────────────────────────────────────────
  const unit = unitQuery.data;
  const selectedChips = QUICK_NOTE_LABELS.filter((label) =>
    note.split('\n').some((line) => line.trim() === label),
  );

  // In-flight/failed cards come from the queue, so there is ONE source of truth
  // for what is on screen.
  const uploading: UploadingState[] = queue
    .filter((item) => item.status === 'uploading' || item.status === 'failed')
    .map((item) => ({
      previewUrl: item.previewUrl,
      note,
      status: item.status === 'failed' ? 'failed' : 'uploading',
    }));

  const attachments = queue.map(toAttachment);

  const openIndex = openPhotoId === null ? -1 : photos.findIndex((p) => p.id === openPhotoId);
  const openPhoto = openIndex === -1 ? null : (photos[openIndex] ?? null);

  if (!mounted || unit === undefined) {
    // "Not loaded yet" is not "not found" - the skeleton mirrors the screen so
    // the layout does not jump when data arrives.
    return (
      <div className="bg-background min-h-dvh p-4" data-qa="site-capture-skeleton">
        <div className="bg-muted-soft h-14 animate-pulse rounded-lg" />
        <div className="bg-muted-soft mt-4 aspect-4/3 w-full animate-pulse rounded-lg" />
        <div className="bg-muted-soft mt-3 h-4 w-2/3 animate-pulse rounded" />
      </div>
    );
  }

  const retryUpload = (): void => {
    // Retry the SAME prepared bytes - never re-capture, never re-prepare.
    setQueue((current) =>
      current.map((q) => (q.status === 'failed' ? { ...q, status: 'ready' } : q)),
    );
    setNoteOpen(true);
  };

  /** Remove one photo from the note. Whatever is already saved stays on record. */
  const removeAttachment = (id: string): void => {
    setQueue((current) => current.filter((item) => item.id !== id));
  };

  const phaseId = unit.phaseId;
  return (
    <>
      <SiteCaptureView
        unit={{
          unitNumber: unit.unitNumber,
          projectName: unit.projectName,
          phaseName: unit.phaseName,
          status: unit.status,
          lastRecordedStage: unit.lastRecordedStage ?? null,
          photoCount: unit.photoCount,
          lastPhotoAt: unit.lastPhotoAt,
          assignedEngineerName: unit.assignedEngineerName ?? null,
        }}
        canCapture={canCaptureSitePhotos(user?.role)}
        backHref={projectHref(orgSlug, projectSlug, '/site')}
        photos={photos}
        isLoading={photosQuery.isLoading}
        isError={photosQuery.isError && !isForbidden(photosQuery.error)}
        onRetry={() => void photosQuery.refetch()}
        hasMore={photosQuery.hasNextPage === true}
        isLoadingMore={photosQuery.isFetchingNextPage}
        onLoadMore={() => void photosQuery.fetchNextPage()}
        uploading={uploading}
        onRetryUpload={retryUpload}
        onDiscardUpload={() => {
          setQueue([]);
          setAnnouncement('');
        }}
        onOpenPhoto={setOpenPhotoId}
        now={now}
        cameraInputRef={cameraInputRef}
        onCameraChange={(file) => {
          if (file !== null) void addToNote([file], 'camera');
        }}
        onCameraClick={() => cameraInputRef.current?.click()}
        onGalleryFiles={(files) => void addToNote(files, 'gallery')}
        onFileReject={(_file, message) => toast.error(message)}
        isPreparing={preparing}
        noteDialog={{
          open: noteOpen,
          onOpenChange: (next) => {
            setNoteOpen(next);
            // Closing the note discards the whole draft: unsent tiles are local
            // only, and anything this dialog already uploaded is deleted from the
            // record. `discardDraft` owns both halves and reports a failed delete
            // instead of pretending it worked.
            //
            // The note text and the stage are part of the SAME draft, so they go
            // with it - leaving them behind made "Discard" look broken, because
            // the typed line came back attached to different photos.
            if (!next) void discardDraft();
          },
          unitNumber: unit.unitNumber,
          phaseName: unit.phaseName,
          attachments,
          onAddFiles: (files, source) => void addToNote(files, source),
          onRemoveAttachment: removeAttachment,
          isPreparing: preparing,
          note,
          onNoteChange: setNote,
          selectedChips,
          onToggleChip: (label, selected) =>
            setNote((current) => toggleNoteLine(current, label, selected)),
          stage,
          onStageChange: setStage,
          isSaving: upload.isPending,
          isOffline: !isOnline,
          onSave: () => void saveBatch(),
        }}
        viewer={{
          photo: openPhoto,
          unitNumber: unit.unitNumber,
          onClose: () => setOpenPhotoId(null),
          hasPrevious: openIndex > 0,
          hasNext: openIndex >= 0 && openIndex < photos.length - 1,
          onPrevious: () => {
            const previous = photos[openIndex - 1];
            if (previous !== undefined) setOpenPhotoId(previous.id);
          },
          onNext: () => {
            const next = photos[openIndex + 1];
            if (next !== undefined) setOpenPhotoId(next.id);
          },
        }}
        announcement={announcement}
        video={
          videoEnabled
            ? {
                onRecord: () => {
                  setPickedClip(null);
                  setRecorderOpen(true);
                },
                onFile: (file) => void pickVideoFile(file),
                fileInputRef: videoInputRef,
              }
            : undefined
        }
      />
      {videoEnabled && canCaptureSitePhotos(user?.role) && phaseId !== undefined ? (
        <SiteRecorder
          open={recorderOpen}
          onOpenChange={(next) => {
            setRecorderOpen(next);
            if (!next) setPickedClip(null);
          }}
          unitId={unitId}
          unitNumber={unit.unitNumber}
          phaseId={phaseId}
          defaultStage={unit.lastRecordedStage ?? null}
          initialClip={pickedClip}
          onSaved={() => setAnnouncement('Update saved.')}
          onChooseFile={() => videoInputRef.current?.click()}
        />
      ) : null}
    </>
  );
}
