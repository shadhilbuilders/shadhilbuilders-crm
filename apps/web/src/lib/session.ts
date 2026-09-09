'use client';

// Session plumbing - better-auth's useSession + our typed user extraction.
import { authClient } from '@/lib/auth-client';

import {
  sessionUserFromSession,
  type SessionUser,
} from '@/apis/client';

type SessionResult = {
  user: SessionUser | null;
  isPending: boolean;
  error: string | null;
};

/** The current signed-in user, typed, with role + teamId. */
export function useSessionUser(): SessionResult {
  const query = authClient.useSession();
  const data = (query ?? {}) as { data?: unknown; isPending?: boolean; error?: unknown };
  const user = sessionUserFromSession(data.data);

  return {
    user,
    isPending: data.isPending === true,
    error:
      data.error !== null && data.error !== undefined
        ? 'Session unavailable'
        : null,
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

/** Cross-role lead moves are ADMIN/OWNER/MANAGER only. */
export function canReassign(role: Role | undefined): boolean {
  return isAdminLike(role) || role === 'MANAGER';
}

/** Manager approval queue visibility (bookings). */
export function canApproveBookings(role: Role | undefined): boolean {
  return isAdminLike(role) || role === 'MANAGER';
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