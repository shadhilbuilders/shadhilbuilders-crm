// Dashboard stats hook - one aggregate endpoint for the project work dashboard.
//
// GET /api/dashboard/stats?projectId=<cuid2> returns all KPI + chart data in a
// single role-scoped query. The hook keys on projectId so switching projects
// refetches (react-query handles the cache invalidation).
//
// Data-confidence honesty (autoplan 2026-09-08, CEO F3): metrics that depend on
// data the team may not produce yet return null/0 HONESTLY - never a fabricated
// number. avgTimeToFirstTouch is null (KPI shows "-"), noShowRate is 0 with a
// "no outcome data yet" sub-label.
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { api, qs } from '@/apis/client';
import type { DashboardExceptions, DashboardStats } from '@shadhil/api-types';

export function useDashboardStats(projectId?: string) {
  return useQuery({
    queryKey: ['dashboard-stats', projectId ?? null] as const,
    queryFn: ({ signal }) =>
      api<DashboardStats>(`/dashboard/stats${qs({ projectId })}`, { signal }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Cross-project problem inbox (admin/owner). GET /api/dashboard/exceptions
 * returns four exception arrays - idle/not-touched leads, at-risk visits,
 * bookings whose money is not moving, and staff who have gone quiet or are
 * overloaded. ADMIN/OWNER only (service guard). Powers the /overview problem-
 * and-resolution surface.
 */
export function useDashboardExceptions() {
  return useQuery({
    queryKey: ['dashboard-exceptions'] as const,
    queryFn: ({ signal }) =>
      api<DashboardExceptions>('/dashboard/exceptions', { signal }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}
