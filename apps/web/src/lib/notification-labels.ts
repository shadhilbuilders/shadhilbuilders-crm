// Friendly names for notification types (2026-11-08).
//
// The notifications page used to print the raw type string ("· lead.created"),
// which is developer vocabulary on a staff surface. Every label here is a
// plain phrase; the fallback is the raw value, so a new notification type that
// nobody has labelled yet is still visible rather than rendered as nothing.
//
// Kept out of the page file because Next route files only export the reserved
// names (default, metadata, dynamic, ...) - a helper exported from a page is a
// build error waiting for typed routes to catch it.
export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  'progress.photo': 'Site photo',
  'progress.assigned': 'Villa assigned',
  'progress.unassigned': 'Villa reassigned',
  'lead.created': 'New lead',
  'lead.transition': 'Lead update',
  'lead.reassigned': 'Lead handed over',
  'booking.created': 'Booking started',
  'booking.transition': 'Booking update',
  'visit.scheduled': 'Visit booked',
  'visit.outcome': 'Visit outcome',
  // Org-level (2026-11-21): a public feedback submission, triaged from the
  // admin feedback inbox.
  'feedback.created': 'New feedback',
};

export function notificationTypeLabel(type: string): string {
  return NOTIFICATION_TYPE_LABELS[type] ?? type;
}
