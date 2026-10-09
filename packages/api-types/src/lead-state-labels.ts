// Friendly lead-state labels - single source shared by the web UI
// (`labelFor('lead', ...)`) and the backend (Activity timeline sentences).
// Pure + framework-free.

import type { LeadState } from './enums';

export const LEAD_STATE_LABELS: Readonly<Record<LeadState, string>> = {
  NEW: 'New',
  CONTACTED: 'Talked',
  VISIT_REQUESTED: 'Visit requested',
  VISIT_SCHEDULED: 'Visit booked',
  VISITED: 'Visited',
  NEGOTIATION: 'Negotiating',
  BOOKING_INITIATED: 'Booking in progress',
  WON: 'Won 🎉',
  LOST: 'Lost',
  RNR: 'Unresponsive',
  RESCHEDULED: 'Postponed',
  NO_SHOW: "Didn't show up",
};

/** Friendly label for a lead state; unknown keys fall back to a humanized form. */
export function leadStateLabel(state: string): string {
  const mapped = (LEAD_STATE_LABELS as Record<string, string>)[state];
  if (mapped !== undefined) return mapped;
  const lower = state.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
