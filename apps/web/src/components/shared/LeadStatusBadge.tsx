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

const STATE_BADGE_CLASS: Record<string, string> = {
  NEW: 'bg-secondary text-secondary-foreground',
  CONTACTED: 'bg-info-soft text-info-foreground',
  VISIT_REQUESTED: 'bg-warning-soft text-warning-foreground',
  VISIT_SCHEDULED: 'bg-warning text-warning-foreground',
  VISITED: 'bg-success-soft text-success-foreground',
  NEGOTIATION: 'bg-info-soft text-info-foreground',
  BOOKING_INITIATED: 'bg-info-soft text-info-foreground',
  WON: 'bg-success text-success-foreground',
  LOST: 'bg-destructive-soft text-destructive-foreground',
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
      {status.replace(/_/g, ' ')}
    </span>
  );
}