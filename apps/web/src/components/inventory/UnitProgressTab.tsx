'use client';

// UnitProgressTab (issue #7 slice 1; 2026-11-08 revision): photo upload + staff
// preview timeline for one unit, rendered INSIDE UnitDetailSheet.
//
// WHO USES THIS NOW: the sales roles. Site staff (ENGINEER/TELECALLER) no longer
// open this sheet - they get `/site/[unitId]`, a real route whose state survives
// a phone unloading a backgrounded tab and whose URL can be shared. This tab
// stays exactly as it is for everyone else, because "what has been photographed
// on this villa" is useful context while quoting it.
//
// PHASE COMES FROM THE UNIT (2026-11-06): `Unit.phaseId` is required, so every
// unit already belongs to exactly one phase and asking was a question the app
// had already answered.
//
// HEIC IS FIXED AT THE SOURCE (2026-11-08): `normalizeMimeType` used to relabel
// whatever the browser declared as image/jpeg while the server sniffed the BYTES
// and refused HEIC - so the relabel cost a round trip and fixed nothing. The
// photo is now converted client-side by `prepareProgressPhoto`, and the payload
// carries the type of the bytes that actually upload.
import { useRef, useState } from 'react';

import { Badge, Button, toast } from '@paalstack/react-ui';
import { LuCamera, LuRefreshCw } from '@paalstack/react-icons/lu';
import type { ConstructionStage } from '@shadhil/api-types';

import { siteMemberLabel } from '@/lib/labels';
import { prepareProgressPhoto, prepareErrorMessage, type PreparedPhoto } from '@/lib/photo-prep';
import type { UnitRow } from '@/hooks/queries/inventory';
import {
  useUnitPhotos,
  useUploadUnitPhoto,
  isForbidden,
  type UploadPhotoInput,
} from '@/hooks/queries/customer-progress';

import { ProgressPhotoActions } from './ProgressPhotoActions';

/** The unit fields this tab needs: its id (the timeline route key) and the
 *  phase every photo it uploads is labelled with. */
export type ProgressUnit = Pick<UnitRow, 'id' | 'phaseId' | 'phaseName'>;

/**
 * Build the upload payload. Pure so the "phase comes from the unit" rule is
 * unit-testable without mounting the tab or driving a real file input.
 *
 * `prepared` is the output of `prepareProgressPhoto`: the mimeType and filename
 * describe the BYTES that will be sent, never the browser's guess from the
 * filename. `caption` and `stage` are omitted entirely when unset so the server
 * keeps its generated-caption fallback.
 */
export function buildPhotoUpload(input: {
  phaseId: string;
  prepared: Pick<PreparedPhoto, 'base64' | 'mimeType' | 'filename' | 'takenAt' | 'source'>;
  caption?: string;
  stage?: ConstructionStage;
}): UploadPhotoInput {
  const caption = input.caption?.trim();
  return {
    phaseId: input.phaseId,
    base64: input.prepared.base64,
    mimeType: input.prepared.mimeType,
    filename: input.prepared.filename.slice(0, 180),
    // Client-captured capture time, WITH offset (toISOString is UTC:Z).
    takenAt: input.prepared.takenAt,
    clientDeviceHint: input.prepared.source,
    // An empty note is valid: the server falls back to its generated caption,
    // so the key is absent rather than an empty string it would have to reject.
    ...(caption !== undefined && caption.length > 0 ? { caption } : {}),
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
  };
}

export function UnitProgressTabContent({ unit }: { unit: ProgressUnit }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [preparing, setPreparing] = useState(false);
  const photosQuery = useUnitPhotos(unit.id);
  const upload = useUploadUnitPhoto(unit.id);

  const photos = (photosQuery.data?.pages ?? []).flatMap((page) => page.photos);

  async function handleFileChosen(file: File): Promise<void> {
    setPreparing(true);
    try {
      const prepared = await prepareProgressPhoto(file, { source: 'camera' });
      upload.mutate(buildPhotoUpload({ phaseId: unit.phaseId, prepared }));
    } catch (err) {
      // One plain sentence, nothing uploaded: no row, no blob, no half state.
      toast.error(prepareErrorMessage(err));
    } finally {
      setPreparing(false);
    }
  }

  if (isForbidden(photosQuery.error)) return null;

  return (
    <div className="space-y-4" data-qa="unit-progress-tab">
      {/* Upload CTA: camera-first. Hidden file input + visible button. The
          phase is no longer a choice - it is the unit's own phase, named
          below so the uploader knows how the photo will be labelled. */}
      <div className="space-y-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // allow re-picking the same file
            if (file) void handleFileChosen(file);
          }}
        />
        <Button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={upload.isPending || preparing}
          isLoading={preparing}
          loadingText="Preparing photo..."
          leftIcon={<LuCamera className="size-4" />}
          data-qa="add-progress-photo"
        >
          {photos.length === 0 && !photosQuery.isLoading ? 'Add first photo' : 'Add photo'}
        </Button>
        <p className="text-muted-foreground text-xs" data-qa="progress-phase-hint">
          Photos are labelled <span className="text-foreground font-medium">{unit.phaseName}</span>.
        </p>
      </div>

      {upload.isError ? (
        <div
          role="alert"
          data-qa="progress-error-banner"
          className="text-destructive bg-destructive-soft flex items-center gap-2 rounded-md px-3 py-2 text-sm"
        >
          <span className="flex-1">
            {upload.error instanceof Error ? upload.error.message : 'Upload failed'}
            {isForbidden(upload.error) ? ' - you are not assigned to this project.' : ''}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => upload.reset()}
            data-qa="progress-error-dismiss"
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      {photosQuery.isLoading ? (
        <div className="space-y-2" data-qa="progress-skeleton">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="border-border bg-muted-soft h-20 animate-pulse rounded-lg border"
            />
          ))}
        </div>
      ) : photosQuery.isError ? (
        <div
          role="alert"
          data-qa="progress-load-error"
          className="text-destructive bg-destructive-soft flex items-center gap-2 rounded-md px-3 py-2 text-sm"
        >
          <span className="flex-1">Could not load the timeline.</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void photosQuery.refetch()}
            data-qa="progress-load-retry"
          >
            <LuRefreshCw className="size-4" /> Retry
          </Button>
        </div>
      ) : photos.length === 0 ? (
        <div
          className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm"
          data-qa="progress-empty"
        >
          No photos yet. The first site photo lands here.
        </div>
      ) : (
        <>
          <ol className="space-y-3" data-qa="progress-timeline">
            {photos.map((p, idx) => (
              <li
                key={p.id}
                className="border-border rounded-lg border"
                data-qa="progress-photo-row"
              >
                <div className="flex items-start gap-3 p-3">
                  {/* Same-origin BFF media URL — cookie-authenticated, so
                      next/image's optimizer would drop the session. Plain
                      <img> is the correct render here (same call as
                      LeadChatPane). */}
                  <img
                    src={p.mediaUrl}
                    alt={p.caption}
                    className="bg-muted-soft size-16 flex-none rounded-md object-cover"
                    loading={idx < 6 ? 'eager' : 'lazy'}
                    data-qa="progress-photo-thumb"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {/* Neutral chip: the phase is now a property of the
                          UNIT, so it is the same on every row and cannot
                          discriminate "current" from "past" any more. Rows
                          uploaded before 2026-11-06 may still carry another
                          phase, which this label reports truthfully. */}
                      {p.phaseName !== null ? (
                        <Badge variant="muted" data-qa="progress-phase-chip">
                          {p.phaseName}
                        </Badge>
                      ) : null}
                      <span className="text-muted-foreground text-xs" data-qa="progress-date">
                        {new Date(p.takenAt).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm" data-qa="progress-caption">
                      {p.caption}
                    </p>
                    <p className="text-muted-foreground text-xs" data-qa="progress-uploader">
                      {siteMemberLabel(p.creatorName, p.creatorIsPhotoLead)}
                    </p>
                    {/* Slice 4: correction controls, offered only where the
                        server's advisory flag says this session may act. The
                        mutation routes re-check against RLS regardless. */}
                    <ProgressPhotoActions photo={p} unitId={unit.id} />
                  </div>
                </div>
              </li>
            ))}
          </ol>
          {photosQuery.data &&
          photosQuery.data.pages[photosQuery.data.pages.length - 1]?.nextCursor ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => void photosQuery.fetchNextPage()}
              disabled={photosQuery.isFetching}
              data-qa="progress-load-more"
            >
              Load more
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
