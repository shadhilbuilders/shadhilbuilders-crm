// Customer-progress client hooks (issue #7 slice 1):
//   GET/POST /api/customer-progress/units/:unitId/photos
//   POST     /api/customer-progress/projects/:projectId/members/:userId/photo-lead
// The BFF catch-all proxies /api/bff/* (rule 7d: no per-route BFF files).
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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
  createdAt: string;
  creatorName: string | null;
  creatorIsPhotoLead: boolean | null;
  mediaUrl: string;
  /**
   * Server-computed advisory: may this session be offered the edit/delete
   * controls? Mirrors the RLS mutation predicate. Always present - false for
   * every CUSTOMER - so the buyer and staff timelines share one wire shape.
   */
  canMutate: boolean;
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
};

const PHOTOS_KEY = ['customer-progress', 'photos'] as const;

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

/** PATCH /customer-progress/photos/:photoId - caption only. */
export function useUpdatePhoto(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ photoId, caption }: { photoId: string; caption: string }) =>
      api<TimelinePhoto>(`/customer-progress/photos/${photoId}`, {
        method: 'PATCH',
        json: { caption },
      }),
    onSuccess: () => {
      // The response carries the corrected DTO, but the row's place in the
      // month sections is derived from the whole loaded set, so a refetch is
      // the honest invalidation. gcTime is 0 on this query, so this is cheap.
      void qc.invalidateQueries({ queryKey: [...PHOTOS_KEY, unitId] });
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
    },
  });
}