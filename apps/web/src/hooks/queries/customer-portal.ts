// Customer-portal client hooks (issue #8 slice 2):
//   GET /api/customer-portal/me
//   GET /api/customer-portal/units/:unitId/photos?cursor=
// via the BFF catch-all (rule 7d: no per-route BFF files).
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';

import { ApiError, api } from '@/apis/client';
import type { TimelinePhoto, TimelineResponse } from '@/hooks/queries/customer-progress';

export type { TimelinePhoto, TimelineResponse };

export type PortalUnit = {
  unitId: string;
  unitNumber: string;
  projectName: string;
  projectId: string;
  currentPhaseName: string | null;
  photoCount: number;
};

export type PortalMe = {
  customerName: string;
  units: PortalUnit[];
};

/** Stable code the backend attaches to the "not linked yet" 403. */
export const NOT_LINKED_CODE = 'CUSTOMER_NOT_LINKED';

/** The lock-screen data carried by the not-linked 403, or null for any other error. */
export function notLinkedInfo(err: unknown): { officePhone: string | null } | null {
  if (!(err instanceof ApiError) || err.status !== 403 || err.code !== NOT_LINKED_CODE) return null;
  const details = err.details as { officePhone?: unknown } | null | undefined;
  return { officePhone: typeof details?.officePhone === 'string' ? details.officePhone : null };
}

const ME_KEY = ['customer-portal', 'me'] as const;
const TIMELINE_KEY = ['customer-portal', 'timeline'] as const;
const PROBE_KEY = ['customer-portal', 'probe'] as const;

const cursorQs = (cursor: string | undefined): string =>
  cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';

export function useCustomerMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => api<PortalMe>('/customer-portal/me'),
    retry: false, // 403s (lock screen) are answers, not blips
  });
}

export function useCustomerTimeline(unitId: string | null) {
  return useInfiniteQuery({
    queryKey: [...TIMELINE_KEY, unitId ?? ''],
    enabled: unitId !== null,
    queryFn: ({ pageParam }: { pageParam?: string }) =>
      api<TimelineResponse>(`/customer-portal/units/${unitId as string}/photos${cursorQs(pageParam)}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
}

/**
 * Deep-link resolution for multi-unit buyers: the push URL carries a photo id
 * but not its unit. Only while a `?photo=` param is present, read the FIRST
 * page of each unit and report which unit holds that photo (null while
 * resolving or when it is not on any first page - the notified photo is the
 * newest, so it is on page one in practice).
 */
export function useDeepLinkUnit(photoId: string | null, unitIds: readonly string[]): string | null {
  const probes = useQueries({
    queries: unitIds.map((unitId) => ({
      queryKey: [...PROBE_KEY, unitId],
      enabled: photoId !== null && unitIds.length > 1,
      queryFn: () => api<TimelineResponse>(`/customer-portal/units/${unitId}/photos`),
      retry: false,
      staleTime: 60_000,
    })),
  });
  if (photoId === null) return null;
  for (let i = 0; i < probes.length; i += 1) {
    if (probes[i]?.data?.photos.some((p) => p.id === photoId)) return unitIds[i] ?? null;
  }
  return null;
}
