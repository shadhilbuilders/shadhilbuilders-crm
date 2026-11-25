// Customer-portal client hooks (issue #8 slice 2):
//   GET /api/customer-portal/me
//   GET /api/customer-portal/units/:unitId/photos?cursor=
// via the BFF catch-all (rule 7d: no per-route BFF files).
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';

import { ApiError, api } from '@/apis/client';
import type { ConstructionStage } from '@shadhil/api-types';

import type { TimelinePhoto, TimelineResponse } from '@/hooks/queries/customer-progress';

export type { TimelinePhoto, TimelineResponse };

export type PortalMilestone = {
  id: string;
  name: string;
  /** ISO datetime or null when no target was set. */
  targetDate: string | null;
  /** ISO datetime once reached; null while pending. */
  completedAt: string | null;
};

export type PortalUnit = {
  unitId: string;
  unitNumber: string;
  projectName: string;
  projectId: string;
  currentPhaseName: string | null;
  photoCount: number;
  /** Staff-entered; null renders nothing (never an estimate). */
  expectedHandoverDate: string | null;
  milestones: PortalMilestone[];

  // ── The unit's own record (2026-11-09) ────────────────────────────────
  // Decimal values arrive as STRINGS (Prisma Decimal serialised over JSON), so
  // every consumer must format rather than do float maths on them.
  plotNumber: number | null;
  bhk: number;
  facing: string | null;
  /** PLOT area in sq.ft. */
  plotSqft: number | null;
  /** Built-up area in sq.ft. */
  buildupSqft: string;
  pricePerSqft: string;
  /** List total: buildupSqft × pricePerSqft, resolved server-side. */
  listAmount: string;
  phaseName: string | null;

  // ── What this buyer owes (their APPROVED booking) ─────────────────────
  negotiatedRate: string | null;
  negotiatedAmount: string | null;
  /** Negotiated when set, else the list total. Always present. */
  finalAmount: string;
  isNegotiated: boolean;
  /**
   * Token / advance received. Null when staff recorded none — distinct from
   * zero, so an unrecorded token never renders as "₹0 paid".
   */
  tokenAmount: string | null;
};

export type PortalMe = {
  customerName: string;
  /**
   * The buyer's own mobile number in canonical E.164 digits, or null when the
   * account is not linked or the lead has no phone (2026-11-26). The hero omits
   * the line entirely for null: a label with nothing after it reads as a fault.
   */
  phone: string | null;
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
const STAGES_KEY = ['customer-portal', 'stages'] as const;
const PROBE_KEY = ['customer-portal', 'probe'] as const;

/**
 * The stage filter's value on the wire (2026-11-25).
 *
 * `'all'` is the absence of a filter, not a stage: it must produce exactly the
 * URL every pre-existing client sends. `'UNSET'` is the server's sentinel for
 * captures that recorded no stage, and the type keeps a typo impossible.
 */
export type StageFilter = 'all' | 'UNSET' | ConstructionStage;

/** Query string for the cursor AND the stage, in one place so they cannot drift. */
const timelineQs = (cursor: string | undefined, stage: StageFilter): string => {
  const params: string[] = [];
  if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
  if (stage !== 'all') params.push(`stage=${encodeURIComponent(stage)}`);
  return params.length === 0 ? '' : `?${params.join('&')}`;
};

export function useCustomerMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => api<PortalMe>('/customer-portal/me'),
    retry: false, // 403s (lock screen) are answers, not blips
  });
}

/**
 * The timeline, optionally narrowed to one stage.
 *
 * The filter is a SERVER query parameter and part of the query key, so each
 * stage is its own paginated list: switching chips starts a fresh cursor chain
 * instead of filtering whatever happened to be loaded. Filtering loaded pages in
 * the browser would show an empty list under a chip that says 24 until the buyer
 * scrolled far enough, which is the bug this shape exists to avoid.
 */
export function useCustomerTimeline(unitId: string | null, stage: StageFilter = 'all') {
  return useInfiniteQuery({
    queryKey: [...TIMELINE_KEY, unitId ?? '', stage],
    enabled: unitId !== null,
    queryFn: ({ pageParam }: { pageParam?: string }) =>
      api<TimelineResponse>(
        `/customer-portal/units/${unitId as string}/photos${timelineQs(pageParam, stage)}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
}

/** One stage's total, as the server counted it. */
export type StageCount = {
  stage: ConstructionStage;
  count: number;
};

/** Per-stage totals plus the captures that recorded no stage. */
export type StageCounts = {
  stages: StageCount[];
  unset: number;
  total: number;
};

/**
 * The chips' numbers, from the server so a heading states a real total rather
 * than "however many you have scrolled past". Sorted by the server in build
 * order; the client never re-sorts, because two orderings is how a ladder ends
 * up starting with FINISHING on one device and FOUNDATION on another.
 */
export function useCustomerStageCounts(unitId: string | null) {
  return useQuery({
    queryKey: [...STAGES_KEY, unitId ?? ''],
    enabled: unitId !== null,
    queryFn: () => api<StageCounts>(`/customer-portal/units/${unitId as string}/stages`),
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
