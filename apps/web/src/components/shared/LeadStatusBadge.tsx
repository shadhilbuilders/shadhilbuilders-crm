'use client';

// Lead-status pill shared by the Lead Inbox (`/leads`) and Lead Detail
// (`/leads/[id]`) pages. Extracted out of the page module so we don't
// re-export a non-allow-listed symbol from an App Router page — Next.js 16's
// generated `.next/types/app/...ts` validator rejects anything other than
// `default` / `metadata` / `generateMetadata` / `generateStaticParams` /
// etc. with a `{ [x: string]: never }` constraint.
//
// Lives next to ModulePending because both are "leads-list/detail" helpers
// that don't belong in the page file itself.
//
// T11: the displayed label comes from `lib/labels.ts` so a non-technical
// user sees "Talked" instead of "CONTACTED". The original
// `status.replace(/_/g, ' ')` was the only site in the codebase that
// leaked a raw enum to the UI; the labels test (`labels.test.ts`)
// asserts every §9.1 enum value has a friendly entry, which would
// fail if this file ever regressed to the raw form.
//
// T-D8: the soft-variant text uses `--{color}-soft-fg` (not
// `--{color}-foreground`) because the library's default
// --success-foreground / --destructive-foreground / --info-foreground
// are near-white, which fails WCAG AA against the soft bg tints. The
// override values in `packages/ui-tokens/src/brand.css` provide the
// dark-foreground variants. The `test/compliance.test.ts` audit
// pins every pair to CR >= 4.5.
import { labelFor } from '@/lib/labels';

const STATE_BADGE_CLASS: Record<string, string> = {
  NEW: 'bg-secondary text-secondary-foreground',
  CONTACTED: 'bg-info-soft text-info-soft-fg',
  VISIT_REQUESTED: 'bg-warning-soft text-warning-foreground',
  VISIT_SCHEDULED: 'bg-warning text-warning-foreground',
  VISITED: 'bg-success-soft text-success-soft-fg',
  NEGOTIATION: 'bg-info-soft text-info-soft-fg',
  BOOKING_INITIATED: 'bg-info-soft text-info-soft-fg',
  WON: 'bg-success text-success-foreground',
  LOST: 'bg-destructive-soft text-destructive-soft-fg',
  COLD: 'bg-secondary text-secondary-foreground',
  NO_SHOW: 'bg-destructive text-destructive-foreground',
  RESCHEDULED: 'bg-warning-soft text-warning-foreground',
  UNKNOWN: 'bg-secondary text-secondary-foreground',
};

export function LeadStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_BADGE_CLASS[status] ?? STATE_BADGE_CLASS['UNKNOWN']}`}
    >
      {labelFor('lead', status)}
    </span>
  );
}