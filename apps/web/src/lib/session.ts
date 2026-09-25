'use client';

// Session plumbing - better-auth's useSession + our typed user extraction.
import { useCallback } from 'react';

import { authClient } from '@/lib/auth-client';

import {
  sessionUserFromSession,
  type SessionUser,
} from '@/apis/client';

type SessionResult = {
  user: SessionUser | null;
  isPending: boolean;
  error: string | null;
  /**
   * Re-read the better-auth session (display name, role). Call after a
   * self-profile write so the app shell stops showing the old name.
   */
  refetchSession: () => Promise<void>;
};

/** The current signed-in user, typed, with role + teamId. */
export function useSessionUser(): SessionResult {
  const query = authClient.useSession();
  const data = (query ?? {}) as {
    data?: unknown;
    isPending?: boolean;
    error?: unknown;
    refetch?: () => Promise<void>;
  };
  const user = sessionUserFromSession(data.data);

  return {
    user,
    isPending: data.isPending === true,
    error:
      data.error !== null && data.error !== undefined
        ? 'Session unavailable'
        : null,
    // better-auth 1.7's react client exposes `refetch` on the same object that
    // carries `data`/`isPending` (verified in
    // better-auth/dist/client/react/index.d.mts). Needed after a self-profile
    // write: the sidebar/topbar read the display name from THIS session, not
    // from the users query, so without a refetch a saved name would leave the
    // shell showing the stale one until the next page load.
    //
    // Wrapped so a harness/binding without `refetch` degrades to a no-op
    // instead of throwing - the save itself has already succeeded at that point.
    refetchSession: useCallback(async () => {
      if (typeof data.refetch !== 'function') return;
      await data.refetch();
    }, [data.refetch]),
  };
}

// ---------------------------------------------------------------------------
// Role helpers (single source: DESIGN.md §4 permission matrix, Model C)
// ---------------------------------------------------------------------------

/** Admin-class sees everything cross-team; Manager is team-scoped. */
export function isAdminLike(role: Role | undefined): boolean {
  return role === 'ADMIN' || role === 'OWNER';
}

/** Manager: manages a team - sees team pipeline, approval queue. */
export function isManager(role: Role | undefined): boolean {
  return role === 'MANAGER';
}

/**
 * MANAGER, ADMIN, or OWNER - can manage a project's structure (staff
 * membership, phases). Mirrors apps/backend/src/users/roles.ts
 * `canManageProjectMembers`.
 */
export function canManageProjectMembers(role: Role | undefined): boolean {
  return isAdminLike(role) || role === 'MANAGER';
}

/**
 * Roles that can be linked to a project as working staff (TELECALLER /
 * SALES_EXEC / MANAGER). ADMIN/OWNER are excluded - you can't link an
 * admin/owner's "work" on a project in this model.
 */
export function isLinkableStaffRole(role: Role | undefined): boolean {
  return (
    role === 'TELECALLER' || role === 'SALES_EXEC' || role === 'MANAGER'
  );
}

/** Cross-role lead moves are ADMIN/OWNER/MANAGER only. */
export function canReassign(role: Role | undefined): boolean {
  return isAdminLike(role) || role === 'MANAGER';
}

/**
 * Booking approval is an ADMIN/OWNER act.
 *
 * MANAGER was revoked 2026-09-24 (owner decision) - it previously returned
 * `isAdminLike(role) || role === 'MANAGER'`, per the then-current DESIGN.md §4.
 * Approving (APPROVED *and* REJECTED - the same decision) now needs admin class.
 * Mirrors the service gate in BookingsService.transition() exactly, so the UI
 * never offers a control the API answers 403 for.
 *
 * Drives: the booking detail Actions card, the bookings list row menu, and the
 * dashboard PendingApprovalsCard. Cancel and "Move to Token" are NOT approval
 * and remain governed by canInitiateBookings / row visibility.
 */
export function canApproveBookings(role: Role | undefined): boolean {
  return isAdminLike(role);
}

/**
 * T-BOOK-ROLES (2026-09-15): "Initiate booking" per DESIGN.md §4 - SuperAdmin /
 * Admin / Manager / Sales Exec. TELECALLER is excluded. Mirrors the service
 * gate in BookingsService.create() and .transition(→ TOKEN), so the UI never
 * offers an action the API answers 403 for.
 */
export function canInitiateBookings(role: Role | undefined): boolean {
  return isAdminLike(role) || role === 'MANAGER' || role === 'SALES_EXEC';
}

/** Audit log: admin + owner read (DESIGN.md §4). */
export function canViewAudit(role: Role | undefined): boolean {
  return isAdminLike(role);
}

/**
 * Lead deletion (autoplan 2026-09-07 D14): OWNER/ADMIN only. Mirrors the
 * `lead_delete_admin` RLS policy (policies.sql:82-84) EXACTLY - the RLS
 * layer has no MANAGER (or OWNER) DELETE policy, so any wider gate here
 * would turn a manager's delete into a silent 0-row write (P2025 → 500).
 * Widening RLS is a security-policy change: see TODOS.md T-RLSMGR.
 */
export function canDeleteLeads(role: Role | undefined): boolean {
  return isAdminLike(role);
}

/**
 * T-E2b follow-up queue (admin-only). ADMIN/OWNER/MANAGER triage
 * inbound WhatsApp messages from unknown numbers (PENDING →
 * CONVERTED → Lead, or PENDING → SPAM). TELECALLER / SALES_EXEC
 * see the converted leads in the regular Lead Inbox instead.
 */
export function canConvertWhatsappUnknownContact(
  role: Role | undefined,
): boolean {
  return isAdminLike(role) || role === 'MANAGER';
}

/** Users module: admin-class creates any role below; manager → staff only. */
export function canManageUsers(role: Role | undefined): boolean {
  return isAdminLike(role) || role === 'MANAGER';
}

// Role rank for the users surface (mirrors apps/backend/src/users/roles.ts
// RANK). Higher = more authority. An actor can edit/delete/change-role a
// target they strictly outrank.
const ROLE_RANK: Record<Role, number> = {
  OWNER: 4,
  ADMIN: 3,
  MANAGER: 2,
  TELECALLER: 1,
  SALES_EXEC: 1,
};

/** True when the actor strictly outranks the target role (users surface). */
export function outranks(actor: Role | undefined, target: Role): boolean {
  if (actor === undefined) return false;
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

/** Telecaller is the only role that schedules + confirms visits (Model C). */
export function canScheduleVisits(role: Role | undefined): boolean {
  return (
    isAdminLike(role) || role === 'MANAGER' || role === 'TELECALLER'
  );
}

/** Exec conducts/log outcomes; telecaller can mark NO_SHOW only. */
export function canLogVisitOutcome(
  role: Role | undefined,
  outcome: 'COMPLETED' | 'NO_SHOW' | 'CANCELLED' | 'RESCHEDULED',
): boolean {
  if (role === undefined) return false;
  if (isAdminLike(role) || isManager(role)) return true;
  if (role === 'SALES_EXEC') return outcome !== 'NO_SHOW';
  if (role === 'TELECALLER') return outcome === 'NO_SHOW';
  return false;
}

type Role = SessionUser['role'];
export type { Role, SessionUser };