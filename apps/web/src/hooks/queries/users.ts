// Users module - the one LIVE backend surface (apps/backend/src/users).
// Endpoints mirror apps/backend/src/users/users.controller.ts:
//   POST   /api/users         → CreatedUser   (role hierarchy enforced server-side)
//   GET    /api/users         → CreatedUser[] (scope filtered per role)
//   PATCH  /api/users/:id/role → CreatedUser
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, qs, type Role } from '@/apis/client';
import type { CountryCode } from '@shadhil/api-types/phone';

export type ReportsToLine = {
  teamId: string;
  teamName: string;
  manager: { id: string; name: string; email: string } | null;
};

export type BackendCreatedUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  teamId: string | null;
  /**
   * Present on list rows ONLY when the caller passed `includePhone`
   * (2026-11-18). Normalized digits-only. For a CUSTOMER row this is derived
   * from their lead - the account stores no phone of its own - and
   * `phoneSource` says which.
   */
  phone?: string | null;
  phoneSource?: 'USER' | 'LEAD';
  /** Project names the user is a member of (via ProjectMember). */
  projects: string[];
  /**
   * "Reports to" - present on GET /users rows only. One entry per team the
   * user belongs to, newest first, each with that team's manager (null when the
   * team is unled). MANAGER/ADMIN get a single org-OWNER entry; OWNER/CUSTOMER
   * get an empty array. Rule: reportingTargetFor in @shadhil/api-types.
   *
   * Absent on create/update responses, hence optional.
   */
  reportsTo?: ReportsToLine[];
  /** @deprecated Use `reportsTo`. First entry's manager, kept one release. */
  reportsToPrimary?: { id: string; name: string; email: string } | null;
};

export type CreateUserInput = {
  name: string;
  email: string;
  password: string;
  role: Role;
  teamId?: string;
  /** Issue #8: required for CUSTOMER, rejected for every other role. */
  customerLeadId?: string;
  /** Staff contact number (2026-11-18). Omitted for CUSTOMER - a buyer's
   *  number lives on their lead, and the server rejects it here. */
  phone?: string;
  /** The country `phone` was typed in; the server parses the digits in it. */
  phoneCountry?: CountryCode;
};

const USERS_KEY = ['users'] as const;

export type UsersFilter = {
  role?: Role[];
  search?: string;
  /** Narrow to staff of ONE project (T-USER-PROJECT-SCOPE). */
  projectId?: string;
  /** Exclude banned users (assignee pickers). */
  availableOnly?: boolean;
  /**
   * Ask the server for each row's `phone` (2026-11-18). OFF by default: this
   * payload also backs the reassign / co-owner / team-member / engineer
   * pickers, which have no business seeing staff mobiles. Only the admin
   * Users table sets it.
   */
  includePhone?: boolean;
  limit?: number;
  offset?: number;
};

export type UsersListResult = {
  rows: BackendCreatedUser[];
  total: number;
};

export function useUsers(filter: UsersFilter = {}) {
  return useQuery({
    queryKey: [
      ...USERS_KEY,
      filter.role ?? [],
      filter.search ?? '',
      // T-USER-PROJECT-SCOPE: part of the KEY, not just the request. Without it
      // the picker would serve the previous project's list from cache.
      filter.projectId ?? '',
      filter.availableOnly ?? false,
      // Part of the key for the same reason: a table showing phones must not
      // be served the cached picker payload that omitted them.
      filter.includePhone ?? false,
      filter.limit,
      filter.offset,
    ],
    queryFn: ({ signal }) =>
      api<UsersListResult>(
        `/users${qs({
          role: filter.role?.join(','),
          search: filter.search,
          projectId: filter.projectId,
          availableOnly: filter.availableOnly ? 'true' : undefined,
          includePhone: filter.includePhone ? 'true' : undefined,
          limit: filter.limit,
          offset: filter.offset,
        })}`,
        { signal },
      ),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * GET /api/users/team - the actor's team + manager, for the chat mention
 * picker. Unlike `useUsers` (staff→self only), this returns the whole team
 * so a telecaller can see + mention their manager and teammates.
 */
export function useTeamMembers(projectId?: string) {
  return useQuery({
    queryKey: ['users', 'team', projectId ?? ''] as const,
    queryFn: ({ signal }) =>
      api<BackendCreatedUser[]>(`/users/team${qs({ projectId })}`, { signal }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * GET /api/users/project/:projectId/sales-execs - SALES_EXEC staff linked
 * to a project, for the schedule-visit exec picker. Server-scoped by role:
 * MANAGER → own team's execs; ADMIN/OWNER → all project execs.
 */
export function useProjectSalesExecs(projectId: string | undefined) {
  return useQuery({
    queryKey: ['users', 'project', projectId, 'sales-execs'] as const,
    enabled: projectId !== undefined && projectId.length > 0,
    queryFn: ({ signal }) =>
      api<BackendCreatedUser[]>(`/users/project/${projectId as string}/sales-execs`, { signal }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export type UserDetailProject = {
  id: string;
  name: string;
};

export type BackendUserDetail = {
  id: string;
  email: string;
  name: string;
  role: Role;
  /**
   * Staff contact number, normalized digits-only (2026-11-18). For a CUSTOMER
   * this is DERIVED from their lead; `phoneSource` says which.
   */
  phone?: string | null;
  phoneSource?: 'USER' | 'LEAD';
  teamId: string | null;
  teamName: string | null;
  /** Populated for TELECALLER/SALES_EXEC/ENGINEER whose team has a manager. */
  manager: { id: string; name: string; email: string } | null;
  /**
   * Every reporting line (2026-11-07): one entry per team the user belongs to,
   * newest first, with that team's manager. `manager` above stays as the
   * single-value view the assign button reads. Optional so a cached response
   * from an older API still parses.
   */
  reportsTo?: ReportsToLine[];
  /** Every team the user belongs to, newest first (2026-11-07). Lets the
   *  assign-manager picker exclude teams they are already on. */
  teamIds?: string[];
  projects: UserDetailProject[];
  /**
   * Photo (2026-11-24). `avatarKey` is the storage key and must never be used as
   * a URL; `imageUrl` is what to render. Optional so a response cached from an
   * older API still parses - the UI falls back to initials.
   */
  avatarKey?: string | null;
  imageUrl?: string | null;
};

/**
 * GET /api/users/:id - the user detail page (users/[userId], autoplan
 * 2026-09-13). Scope mirrors `useUsers`: ADMIN/OWNER see anyone; MANAGER
 * sees their own team + self; staff see only themselves (server-enforced).
 */
export function useUser(id: string | undefined) {
  return useQuery({
    queryKey: [...USERS_KEY, id ?? ''],
    enabled: id !== undefined && id.length > 0,
    queryFn: ({ signal }) => api<BackendUserDetail>(`/users/${id as string}`, { signal }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) =>
      api<BackendCreatedUser>('/users', { method: 'POST', json: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
      // Creating a MANAGER auto-creates their team server-side, so the team
      // list the create dialog's Combobox reads must be refreshed too.
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });
}

export function useChangeUserRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      api<BackendCreatedUser>(`/users/${id}/role`, {
        method: 'PATCH',
        json: { role },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    // `phone: null` CLEARS the number; omitting it leaves the stored value
    // untouched (2026-11-18). The distinction is preserved by sending the key
    // only when the caller set it.
    mutationFn: ({
      id,
      name,
      email,
      phone,
      phoneCountry,
    }: {
      id: string;
      name?: string;
      email?: string;
      phone?: string | null;
      phoneCountry?: CountryCode;
    }) =>
      api<BackendCreatedUser>(`/users/${id}`, {
        method: 'PATCH',
        json: {
          ...(name !== undefined ? { name } : {}),
          ...(email !== undefined ? { email } : {}),
          ...(phone !== undefined ? { phone } : {}),
          ...(phoneCountry !== undefined ? { phoneCountry } : {}),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });
}

/** Result of PATCH /api/users/me (self-profile edit, settings page). */
export type BackendUpdatedProfile = {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Staff contact number, normalized digits-only. Null when unset (2026-11-18). */
  phone: string | null;
  /** Storage key of the photo, or null after a removal (2026-11-24). */
  avatarKey: string | null;
  /** Server-resolved render URL for `avatarKey`. Null when there is no photo. */
  imageUrl: string | null;
};

/**
 * PATCH /api/users/me - edit your OWN profile name/phone (settings page,
 * 2026-09-18; phone 2026-11-18).
 *
 * No id is passed: the backend resolves the target from the JWT subject, so
 * this hook cannot be misused to edit someone else. Deliberately NOT built on
 * `useUpdateUser` - PATCH /users/:id is the hierarchy-gated ADMIN route and it
 * refuses self-edits, so routing a self-edit through it would 403.
 *
 * `phone: null` clears the number. A CUSTOMER receives a 400 from the service
 * if they send one at all - their number lives on their lead.
 *
 * Invalidates the users list (so an admin's directory shows the new name), and
 * the caller follows up with a session refetch - the sidebar/topbar read the
 * name from the better-auth session, not from this query.
 */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      name,
      phone,
      phoneCountry,
      email,
      currentPassword,
      avatarKey,
    }: {
      name?: string;
      phone?: string | null;
      /** The country `phone` was typed in; sent only with a number. */
      phoneCountry?: CountryCode;
      /** Only ever a placeholder -> real change; the API refuses anything else. */
      email?: string;
      currentPassword?: string;
      /**
       * Storage key from a completed POST /api/media upload, or null to remove
       * the photo (2026-11-24). The server re-checks the org namespace and the
       * stored bytes, so a wrong key comes back as a 400 with a message.
       */
      avatarKey?: string | null;
    }) =>
      api<BackendUpdatedProfile>('/users/me', {
        method: 'PATCH',
        json: {
          ...(name !== undefined ? { name } : {}),
          ...(phone !== undefined ? { phone } : {}),
          ...(phoneCountry !== undefined ? { phoneCountry } : {}),
          ...(email !== undefined ? { email, currentPassword } : {}),
          ...(avatarKey !== undefined ? { avatarKey } : {}),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });
}

/**
 * PATCH /api/users/:id/manager - assign/reassign the reporting line for a
 * TELECALLER/SALES_EXEC/ENGINEER (autoplan 2026-09-13; ENGINEER 2026-11-07).
 * TELECALLER/SALES_EXEC are MOVED into the manager's team; ENGINEER is ADDED
 * to it (existing memberships are kept - team membership grants project
 * access) and only ADMIN/OWNER may do it.
 * Invalidates the user-detail query too (not just the list) so the
 * detail page's manager/team panel refreshes immediately.
 */
export function useAssignManager() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, teamId }: { id: string; teamId: string }) =>
      api<BackendCreatedUser>(`/users/${id}/manager`, {
        method: 'PATCH',
        json: { teamId },
      }),
    onSuccess: (_data, { id }) => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
      void queryClient.invalidateQueries({ queryKey: [...USERS_KEY, id] });
    },
  });
}

/**
 * POST /api/users/:id/change-password as an ADMIN/OWNER reset of ANOTHER
 * user (no current password sent; the backend enforces rank hierarchy).
 * Audited server-side.
 */
export function useResetUserPassword() {
  return useMutation({
    mutationFn: ({ id, newPassword }: { id: string; newPassword: string }) =>
      api<{ ok: true; mustChangePassword: false }>(`/users/${id}/change-password`, {
        method: 'POST',
        json: { newPassword },
      }),
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
  });
}

export { qs };
