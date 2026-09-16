// Shared booking-domain helpers.
//
// Mirrors lib/leads.ts: small pure rules that a page would otherwise inline
// where they cannot be tested. This repo has no @testing-library/react, so a
// redirect decided inside a mutation callback - reachable only by submitting a
// form - is invisible to the test suite. Extracting the destination makes the
// rule assertable, which matters because the wrong target is a silent UX bug:
// nothing errors, the operator just lands somewhere unhelpful.
import { projectHref } from '@/lib/nav';

/**
 * Where to send the operator after a booking is created.
 *
 * The BOOKINGS LIST. The created entity is a booking, so the operator wants to
 * see it in context among the project's other bookings. The parent lead's page
 * was the previous destination (mirroring the leads form, which correctly
 * redirects to the created LEAD) - but a lead page renders no booking panel at
 * all, so it gave no confirmation that anything had been created.
 *
 * Takes the org/project slugs rather than the created row because the target
 * does not depend on the new booking's id; keeping it id-free means the rule
 * cannot drift into a `/bookings/:id` deep link by accident.
 */
export function afterBookingCreateHref(
  orgSlug: string | null,
  projectSlug: string | null,
): string {
  return projectHref(orgSlug, projectSlug, '/bookings');
}
