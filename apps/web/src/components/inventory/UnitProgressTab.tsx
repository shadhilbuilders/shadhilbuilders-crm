'use client';

// UnitProgressTab (issue #7 slice 1): photo upload + staff preview timeline
// for one unit, rendered INSIDE UnitDetailSheet.
//
// States (adopted table): skeleton cards, warm empty, inline error banner +
// retry, hasMore load-more. The tab visibility contract lives in the SHEET:
// the timeline GET returning 2xx is the only thing that renders this tab
// (a 403 non-member hides it entirely).
import { Badge, Button, Select } from '@paalstack/react-ui';
import { LuCamera, LuRefreshCw } from '@paalstack/react-icons/lu';
import { useRef, useState } from 'react';

import { siteMemberLabel } from '@/lib/labels';
import type { PhaseRow } from '@/hooks/queries/inventory';
import {
  useUnitPhotos,
  useUploadUnitPhoto,
  type TimelinePhoto,
} from '@/hooks/queries/customer-progress';

type ApiErrorLike = { status?: number };

function isForbidden(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as ApiErrorLike).status === 403;
}

/** The chip is green on the phase of the unit's MOST RECENT photo in the
 *  loaded set (spec: "green where current"); otherwise neutral. */
function latestPhaseId(photos: TimelinePhoto[]): string | null {
  return photos.length > 0 ? (photos[0]?.phaseId ?? null) : null;
}

export function UnitProgressTabContent({ unitId, phases }: { unitId: string; phases: PhaseRow[] }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingPhaseId, setPendingPhaseId] = useState<string>('');
  const photosQuery = useUnitPhotos(unitId);
  const upload = useUploadUnitPhoto(unitId);

  const photos = (photosQuery.data?.pages ?? []).flatMap((page) => page.photos);
  const greenPhaseId = latestPhaseId(photos);

  async function handleFileChosen(file: File): Promise<void> {
    if (!pendingPhaseId) {
      upload.reset();
      // toast surfaces via the mutation error path (inline banner below).
      return;
    }
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const comma = result.indexOf(',');
        resolve(comma === -1 ? '' : result.slice(comma + 1));
      };
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(file);
    });
    if (!base64) return;
    upload.mutate({
      phaseId: pendingPhaseId,
      base64,
      mimeType: file.type === 'image/png' ? 'image/png' : file.type === 'image/webp' ? 'image/webp' : 'image/jpeg',
      filename: file.name.slice(0, 180),
      // Client-captured capture time, WITH offset (toISOString is UTC:Z).
      takenAt: new Date(file.lastModified).toISOString(),
      clientDeviceHint: 'camera',
    });
    setPendingPhaseId('');
  }

  if (isForbidden(photosQuery.error)) return null;

  return (
    <div className="space-y-4" data-qa="unit-progress-tab">
      {/* Upload CTA: camera-first. Hidden file input + visible button. */}
      <div className="space-y-2">
        <Select
          value={pendingPhaseId}
          onValueChange={(v) => setPendingPhaseId(v ?? '')}
          options={phases.map((p) => ({ value: p.id, label: p.name }))}
          placeholder={phases.length > 0 ? 'Phase for this photo' : 'No phases yet'}
          data-qa="progress-phase-select"
        />
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
          disabled={upload.isPending || phases.length === 0}
          leftIcon={<LuCamera className="size-4" />}
          data-qa="add-progress-photo"
        >
          {photos.length === 0 && !photosQuery.isLoading ? 'Add first photo' : 'Add photo'}
        </Button>
        {phases.length === 0 ? (
          <p className="text-muted-foreground text-xs">This project has no phases yet - add one before uploading photos.</p>
        ) : null}
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
          <Button type="button" variant="ghost" size="sm" onClick={() => upload.reset()} data-qa="progress-error-dismiss">
            Dismiss
          </Button>
        </div>
      ) : null}

      {photosQuery.isLoading ? (
        <div className="space-y-2" data-qa="progress-skeleton">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border-border bg-muted-soft h-20 animate-pulse rounded-lg border" />
          ))}
        </div>
      ) : photosQuery.isError ? (
        <div
          role="alert"
          data-qa="progress-load-error"
          className="text-destructive bg-destructive-soft flex items-center gap-2 rounded-md px-3 py-2 text-sm"
        >
          <span className="flex-1">Could not load the timeline.</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void photosQuery.refetch()} data-qa="progress-load-retry">
            <LuRefreshCw className="size-4" /> Retry
          </Button>
        </div>
      ) : photos.length === 0 ? (
        <div className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm" data-qa="progress-empty">
          No photos yet. The first site photo lands here.
        </div>
      ) : (
        <>
          <ol className="space-y-3" data-qa="progress-timeline">
            {photos.map((p, idx) => {
              const green = p.phaseId !== null && p.phaseId === greenPhaseId;
              return (
                <li key={p.id} className="border-border rounded-lg border" data-qa="progress-photo-row">
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
                        {p.phaseName !== null ? (
                          <Badge variant={green ? 'success' : 'muted'} data-qa="progress-phase-chip">
                            {p.phaseName}
                          </Badge>
                        ) : null}
                        <span className="text-muted-foreground text-xs" data-qa="progress-date">
                          {new Date(p.takenAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-sm" data-qa="progress-caption">{p.caption}</p>
                      <p className="text-muted-foreground text-xs" data-qa="progress-uploader">
                        {siteMemberLabel(p.creatorName, p.creatorIsPhotoLead)}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          {photosQuery.data && photosQuery.data.pages[photosQuery.data.pages.length - 1]?.nextCursor ? (
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