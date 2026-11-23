// Customer-progress client hooks (issue #7 slice 1):
//   GET/POST /api/customer-progress/units/:unitId/photos
//   POST     /api/customer-progress/projects/:projectId/members/:userId/photo-lead
// The BFF catch-all proxies /api/bff/* (rule 7d: no per-route BFF files).
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import type { ConstructionStage } from '@shadhil/api-types';

import { api } from '@/apis/client';

export type TimelinePhoto = {
  id: string;
  unitId: string;
  phaseId: string | null;
  phaseName: string | null;
  mimeType: string;
  filename: string;
  caption: string;
  takenAt: string;
  /** Construction stage recorded with the capture, or null when unrecorded.
   *  Null is "not recorded", never "not started". */
  stage: ConstructionStage | null;
  createdAt: string;
  creatorName: string | null;
  creatorIsPhotoLead: boolean | null;
  /**
   * Still image for a photo; the POSTER frame for a video, so every existing
   * <img> consumer keeps working unchanged.
   */
  mediaUrl: string;
  /** 'PHOTO' when absent (older servers, flag off). */
  kind?: 'PHOTO' | 'VIDEO';
  /** The clip itself, present only for a video. */
  videoUrl?: string | null;
  durationMs?: number | null;
  hasAudio?: boolean | null;
  archived?: boolean;
  /**
   * Server-computed advisory: may this session be offered the edit/delete
   * controls? Mirrors the RLS mutation predicate. Always present - false for
   * every CUSTOMER - so the buyer and staff timelines share one wire shape.
   */
  canMutate: boolean;
  /**
   * Staff only (step 8): how the buyer-facing WhatsApp send for this row's batch
   * ended. Null on the buyer's own timeline, on a row from before step 8, and
   * when no delivery row exists - all of which mean "nothing to report", never
   * "failed".
   */
  whatsappStatus?:
    | 'PENDING'
    | 'SENT'
    | 'DELIVERED'
    | 'READ'
    | 'SKIPPED_WINDOW'
    | 'SKIPPED_NO_TEMPLATE'
    | 'SKIPPED_NO_BUYER'
    | 'SKIPPED_NO_CONSENT'
    | 'SKIPPED_DISABLED'
    | 'FAILED'
    | null;
  /** When the buyer opened it (staff only, ISO). Only meaningful with READ. */
  whatsappReadAt?: string | null;
};

export type TimelineResponse = {
  photos: TimelinePhoto[];
  nextCursor: string | null;
};

type ApiErrorLike = { status?: number };

/** True when a customer-progress error is the 403 non-member denial. Shared
 *  by the Progress tab (hide itself on 403, per the sheet's visibility
 *  contract) and the sheet's gate that removes the tab chrome entirely for
 *  non-booking roles. */
export function isForbidden(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as ApiErrorLike).status === 403;
}

export type UploadPhotoInput = {
  phaseId: string;
  base64: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  filename: string;
  takenAt: string;
  clientDeviceHint?: 'camera' | 'gallery';
  /** The engineer's one-line note (2026-11-08). Omitted when empty, so the
   *  server falls back to its generated caption. */
  caption?: string;
  /** Construction stage recorded with this capture. Omitted when unset. */
  stage?: ConstructionStage;
};

const PHOTOS_KEY = ['customer-progress', 'photos'] as const;

/**
 * A unit row carries `lastRecordedStage` / `lastPhotoAt` / `photoCount`, all
 * derived server-side. Any photo or video write must refresh the unit too
 * (single and list keys), or the header badge keeps showing "Stage not set"
 * until a reload.
 */
function invalidateUnitRows(qc: ReturnType<typeof useQueryClient>, unitId: string): void {
  void qc.invalidateQueries({ queryKey: ['inventory', 'unit', unitId] });
  void qc.invalidateQueries({ queryKey: ['inventory', 'units'] });
}

export function useUnitPhotos(unitId: string | null) {
  return useInfiniteQuery({
    queryKey: [...PHOTOS_KEY, unitId ?? ''],
    enabled: unitId !== null,
    queryFn: ({ pageParam }: { pageParam?: string }) => {
      const qs = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : '';
      return api<TimelineResponse>(`/customer-progress/units/${unitId as string}/photos${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // The Progress tab is opened fresh each time the sheet opens; stale
    // timelines read as "upload failed" during the upload round trip.
    gcTime: 0,
    retry: false, // a 403 (non-member) must not retry; the tab hides itself on 403
  });
}

export function useUploadUnitPhoto(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UploadPhotoInput) =>
      api<TimelinePhoto>(`/customer-progress/units/${unitId}/photos`, {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => {
      // Refresh every page of this unit's timeline + the first page the tab
      // reads back with after success.
      void qc.invalidateQueries({ queryKey: PHOTOS_KEY });
      invalidateUnitRows(qc, unitId);
    },
  });
}

export type SetPhotoLeadInput = { photoLead: boolean };

export function useSetPhotoLead(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, photoLead }: { userId: string } & SetPhotoLeadInput) =>
      api<{ userId: string; projectId: string; photoLead: boolean }>(
        `/customer-progress/projects/${projectId}/members/${userId}/photo-lead`,
        { method: 'POST', json: { photoLead } },
      ),
    onSuccess: () => {
      // Project team rows now carry the CURRENT photo-lead state (key shape
      // matches hooks/queries/project-teams.ts PROJECT_TEAMS_KEY).
      void qc.invalidateQueries({ queryKey: ['projects', 'teams', projectId] });
    },
  });
}

// ── Photo correction (slice 4, 2026-11-07) ──────────────────────────────────
// Authority is the server's: ADMIN, the uploader, or the project's photo lead.
// A denied actor gets 404 from the API, so the UI shows the server's message
// rather than guessing from the role - and a hidden control is a courtesy, not
// the wall.

/** PATCH /customer-progress/photos/:photoId - caption and/or stage, partial. */
export function useUpdatePhoto(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    // PARTIAL by design: a stage-only correction must not clear the caption,
    // and a caption-only correction must not clear the stage.
    mutationFn: ({
      photoId,
      caption,
      stage,
    }: {
      photoId: string;
      caption?: string;
      stage?: ConstructionStage;
    }) =>
      api<TimelinePhoto>(`/customer-progress/photos/${photoId}`, {
        method: 'PATCH',
        json: {
          ...(caption !== undefined ? { caption } : {}),
          ...(stage !== undefined ? { stage } : {}),
        },
      }),
    onSuccess: () => {
      // The response carries the corrected DTO, but the row's place in the
      // month sections is derived from the whole loaded set, so a refetch is
      // the honest invalidation. gcTime is 0 on this query, so this is cheap.
      void qc.invalidateQueries({ queryKey: [...PHOTOS_KEY, unitId] });
      invalidateUnitRows(qc, unitId);
    },
  });
}

/** DELETE /customer-progress/photos/:photoId - row then bytes. */
export function useDeletePhoto(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (photoId: string) =>
      api<{ id: string; unitId: string }>(`/customer-progress/photos/${photoId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...PHOTOS_KEY, unitId] });
      invalidateUnitRows(qc, unitId);
    },
  });
}
