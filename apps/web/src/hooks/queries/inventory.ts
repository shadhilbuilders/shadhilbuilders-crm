// Inventory hooks - villa/unit availability grid (DESIGN.md module 4).
//
// Wire-shape contract (verified 2026-09-10, inventory module live):
//   - GET /api/inventory/units returns `{ total, rows }` (UnitListResult).
//     useInventoryUnits unwraps `rows` so the page reads `.data` as an array.
//   - GET /api/inventory/phases returns a bare `PhaseRow[]` array.
//   - POST/PATCH /api/inventory/units are ADMIN/OWNER-only (service guard).
//
// T24 (PR3): list-shape queries use `placeholderData: keepPreviousData` so
// the skeleton only renders on first load, not on refetch.
//
// T-INV-SYNC (2026-09-15): Unit.status is derived from the booking lifecycle,
// so unit writes and booking writes touch the same two caches. Both hook
// families invalidate ['inventory', ...] AND ['bookings'] - otherwise the
// inventory grid and the bookings list disagree until the next refetch.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, qs } from '@/apis/client';

import type {
  CreatePhaseDto,
  CreateProjectOptionDto,
  CreateUnitDto,
  UpdatePhaseDto,
  UpdateUnitDto,
} from '@shadhil/api-types';

/** Invalidate both sides of the unit/booking status relationship. */
function invalidateInventoryAndBookings(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  void queryClient.invalidateQueries({ queryKey: ['inventory', 'units'] });
  void queryClient.invalidateQueries({ queryKey: ['inventory', 'phases'] });
  void queryClient.invalidateQueries({ queryKey: ['bookings'] });
}

export type UnitRow = {
  id: string;
  phaseId: string;
  phaseName: string;
  projectId: string;
  projectName: string;
  unitNumber: string;
  bhk: number;
  facing: string | null;
  sqft: number | null;
  price: string;
  status: string;
  createdAt: string;
};

export type PhaseRow = {
  id: string;
  projectId: string;
  name: string;
  unitCount: number;
};

type WithRows<T> = { total: number; rows: T[] };

function unwrapRows<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (
    payload !== null &&
    typeof payload === 'object' &&
    Array.isArray((payload as WithRows<T>).rows)
  ) {
    return (payload as WithRows<T>).rows;
  }
  return [];
}

export type InventoryFilter = {
  projectId?: string;
  phaseId?: string;
  bhk?: number;
  facing?: string;
  status?: string[];
  limit?: number;
  offset?: number;
};

export function useInventoryUnits(filter: InventoryFilter = {}) {
  return useQuery({
    queryKey: ['inventory', 'units', filter] as const,
    queryFn: ({ signal }) =>
      api<unknown>(
        `/inventory/units${qs({
          projectId: filter.projectId,
          phaseId: filter.phaseId,
          bhk: filter.bhk,
          facing: filter.facing,
          status: filter.status?.join(','),
          limit: filter.limit,
          offset: filter.offset,
        })}`,
        { signal },
      ),
    select: unwrapRows<UnitRow>,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

/** Read the raw `{ total, rows }` envelope for the SAME key useInventoryUnits
 *  caches under (server pagination needs `total`). */
export function useInventoryUnitsEnvelope(filter: InventoryFilter = {}): number {
  const query = useQuery({
    queryKey: ['inventory', 'units', filter] as const,
    queryFn: ({ signal }) =>
      api<unknown>(
        `/inventory/units${qs({
          projectId: filter.projectId,
          phaseId: filter.phaseId,
          bhk: filter.bhk,
          facing: filter.facing,
          status: filter.status?.join(','),
          limit: filter.limit,
          offset: filter.offset,
        })}`,
        { signal },
      ),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
  const raw = query.data;
  if (raw !== null && typeof raw === 'object') {
    const total = (raw as { total?: unknown }).total;
    if (typeof total === 'number') return total;
  }
  return 0;
}

export function useInventoryPhases(projectId?: string) {
  return useQuery({
    queryKey: ['inventory', 'phases', projectId ?? ''] as const,
    queryFn: ({ signal }) =>
      api<PhaseRow[]>(`/inventory/phases${qs({ projectId })}`, { signal }),
    staleTime: 30_000,
  });
}

export function useCreateUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUnitDto) =>
      api<UnitRow>('/inventory/units', { method: 'POST', json: body }),
    onSuccess: () => {
      invalidateInventoryAndBookings(queryClient);
    },
  });
}

export function useUpdateUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; body: UpdateUnitDto }) =>
      api<UnitRow>(`/inventory/units/${args.id}`, {
        method: 'PATCH',
        json: args.body,
      }),
    onSuccess: () => {
      invalidateInventoryAndBookings(queryClient);
    },
  });
}

export function useDeleteUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ id: string }>(`/inventory/units/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidateInventoryAndBookings(queryClient);
    },
  });
}

export function useCreatePhase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePhaseDto) =>
      api<PhaseRow>('/inventory/phases', { method: 'POST', json: body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'phases'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'units'] });
    },
  });
}

export function useUpdatePhase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; body: UpdatePhaseDto }) =>
      api<PhaseRow>(`/inventory/phases/${args.id}`, {
        method: 'PATCH',
        json: args.body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'phases'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'units'] });
    },
  });
}

export function useDeletePhase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ id: string }>(`/inventory/phases/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'phases'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory', 'units'] });
    },
  });
}

export type ProjectOptionRow = {
  id: string;
  projectId: string;
  type: 'FACING' | 'BHK';
  value: string;
  unitCount: number;
  createdAt: string;
};

/** The active project's option sets, optionally narrowed by type. */
export function useProjectOptions(
  projectId: string | undefined,
  type?: 'FACING' | 'BHK',
) {
  return useQuery({
    queryKey: ['inventory', 'options', projectId ?? '', type ?? ''] as const,
    queryFn: ({ signal }) =>
      api<ProjectOptionRow[]>(
        `/inventory/options${qs({ projectId, type })}`,
        { signal },
      ),
    enabled: projectId !== undefined,
    staleTime: 30_000,
  });
}

export function useCreateProjectOption() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectOptionDto) =>
      api<ProjectOptionRow>('/inventory/options', { method: 'POST', json: body }),
    onSuccess: (_data, body) => {
      void queryClient.invalidateQueries({
        queryKey: ['inventory', 'options', body.projectId],
      });
    },
  });
}

export function useDeleteProjectOption() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; projectId: string }) =>
      api<{ id: string }>(`/inventory/options/${args.id}`, { method: 'DELETE' }),
    onSuccess: (_data, args) => {
      void queryClient.invalidateQueries({
        queryKey: ['inventory', 'options', args.projectId],
      });
    },
  });
}
