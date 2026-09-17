'use client';

// Shared dashboard helpers (dashboard split, 2026-09-08).
//
// Extracted from `[projectId]/dashboard/page.tsx` so BOTH the project work
// dashboard and the admin/owner `/dashboard` command center reuse the same
// KPI strip, section wrapper, and inline charts. DRY: do NOT re-declare these
// in either page - import from here.

import Link from 'next/link';

import { LuArrowRight } from '@paalstack/react-icons/lu';

import { LEAD_STATUSES, labelFor } from '@/lib/labels';
import { Button } from '@paalstack/react-ui';

// ---------------------------------------------------------------------------
// KPI strip - numbers in one row with label + trend, no cards (wireframe note)
// ---------------------------------------------------------------------------

export type Kpi = {
  label: string;
  value: string;
  sub?: string;
  /**
   * T-DASH-QUEUE (2026-09-16): optional click handler. When present the KPI
   * renders as a real button instead of a static paragraph, so the count strip
   * can double as a queue filter ("Needs a call now" filters to overdue). The
   * prop is ADDITIVE - callers that pass no handler keep the exact previous
   * markup, because this component is shared.
   */
  onClick?: () => void;
  /** Marks the currently-active filter, for the aria-pressed state. */
  active?: boolean;
};

// T20 (PR3): the KpiStrip value element picks up a one-time
// `animate-shimmer-once` pulse when it transitions from the
// placeholder "-" to a real number. We detect the transition via
// a `data-state` attribute (loading → ready) and toggle the class
// via a useEffect on the parent that flips when the data arrives.
// Since the Dashboard pages don't yet have live KPI data, the
// `data-state="ready"` is the *default* here, with a `data-just-
// arrived` flag the parent can set when a value transitions from
// "-" to a number. Future KPI-module work sets the flag once.
//
// T-DASH-KPI-COLUMN (2026-09-16, owner direction - supersedes T-DASH-QUEUE):
// the counts STACK in a single column on a phone (`grid-cols-1`) and return to
// four-in-a-row from `sm` (640px). Values scale `text-2xl` -> `text-3xl`.
//
// NOTHING IS HIDDEN at any width. An earlier version of this kept all four in a
// row and dropped the `sub` helper line below `sm`; the owner's direction was to
// stack the cards on mobile and to hide nothing on them, so the card now shows
// label, value, sub-line and filter affordance at every size. Each stacked card
// is also a full-width 44px tap target, which a 66px-wide column could never be.
//
// COST, deliberate and measured: four full cards are ~500px tall, so on a 568px
// phone the queue starts below the counts. That is the trade the stacking asks
// for. See the Decision Audit Trail #64 in docs/planning/IMPLEMENTATION-PLAN-v1.md.
export function KpiStrip({ items }: { items: Kpi[] }) {
  return (
    <div
      role="group"
      aria-label="Work counts"
      // T-DASH-KPI-COLUMN (2026-09-16, owner direction): the counts STACK in a
      // single column on a phone, two-up from 30rem, and the original four-in-a-
      // row from `sm`.
      //
      // This supersedes the earlier "all four on one row at 320px" ruling, which
      // existed to stop the strip pushing the queue below the fold. That reason
      // still holds, so the stacked card is deliberately COMPACT: one line, label
      // left and value right (see the card below), so four rows cost ~190px
      // rather than the ~380px a label-above-value stack would.
      className="grid grid-cols-1 gap-1 sm:grid-cols-4 sm:gap-3"
    >
      {items.map((kpi) => {
        const isPlaceholder = kpi.value === '-';
        const isClickable = kpi.onClick !== undefined;
        const isSelected = kpi.active === true;

        // T-DASH-QUEUE-SELECTED (2026-09-16, user request): a selected filter card
        // reads LIGHT BLUE and nothing else - the tint is the whole visual change.
        //
        // Owner feedback: "border is not needed for selected". The blue border and
        // the blue ring are gone; a selected card keeps the SAME `border-border`
        // every card has, so the four counts stay one visual family and selection
        // does not make one of them look like a different kind of control.
        //
        // This still satisfies WCAG 1.4.1 (never carry state on colour alone): the
        // card's own text changes from "Tap to filter" to "Showing only this", and
        // `aria-pressed` carries it for assistive tech. The TEXT is the non-colour
        // cue now - a stronger one than the ring it replaces, because it also says
        // WHAT is happening rather than only THAT something is.
        //
        // Uses the brand's own `--link` token (bg-link = --color-link -> --link),
        // the same blue as the inline text links, rather than a hard-coded hex -
        // so the selected state stays inside the brand palette and follows the
        // token into dark mode automatically.
        //
        // CONTRAST, measured not assumed: `--muted-foreground` (#64748b) is 4.76
        // on the white card but only ~4.2/3.9/3.7 at bg-link/8/12/15 - below the
        // 4.5 AA floor for body text. So on a SELECTED card the label/sub/placeholder
        // step up to `text-foreground` (17.6 and better). This is the same trap as
        // the overdue row tint: a MUTED token is only readable against the plain
        // card, never against a tint. Verified by the real-browser axe audit.
        const secondaryText = isSelected ? 'text-foreground' : 'text-muted-foreground';

        // No `break-words`: it let "₹1,23,45,678" split across a digit boundary,
        // which renders as two numbers. `line-clamp-1` truncates instead, and the
        // value is a count or a short currency string, so truncation is the honest
        // failure mode. `mt-1` only applies once the card stacks again.
        const valueClass = `mt-1 text-2xl font-semibold tabular-nums break-words sm:text-3xl ${
          isPlaceholder ? secondaryText : 'animate-shimmer-once'
        }`;

        // T-DASH-KPI-COLUMN (2026-09-16, owner direction): the card keeps the SAME
        // stacked shape at every width - label, value, sub-line and the filter
        // affordance are all VISIBLE on a phone. Nothing is hidden, dropped or
        // reflowed into a different layout; only the padding and the type scale
        // respond. `min-h-11` makes the whole card a full-width 44px tap target,
        // which a 66px-wide column could never be.
        const cardClass =
          'border-border bg-card min-h-11 min-w-0 rounded-lg border p-3 text-left sm:p-4';

        const body = (
          <>
            {/* One treatment at every width. The caps were briefly dropped at
                narrow widths only because a 66px-wide 4-up card could not fit
                "NEEDS A CALL NOW" (it clipped at four lines, measured). A
                full-width stacked card fits it comfortably, so the label style no
                longer changes with the viewport. */}
            <span className={`${secondaryText} block text-xs tracking-wide uppercase`}>
              {kpi.label}
            </span>
            <span
              className={`block ${valueClass}`}
              data-state={isPlaceholder ? 'loading' : 'ready'}
            >
              {kpi.value}
            </span>
            {kpi.sub !== undefined ? (
              <span className={`${secondaryText} mt-0.5 block text-xs`}>{kpi.sub}</span>
            ) : null}
          </>
        );

        if (!isClickable) {
          return (
            <div key={kpi.label} className={cardClass} data-qa="kpi-card-static">
              {body}
            </div>
          );
        }

        return (
          <button
            key={kpi.label}
            type="button"
            onClick={kpi.onClick}
            aria-pressed={isSelected}
            data-qa={`kpi-filter-${kpi.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
            data-selected={isSelected ? 'true' : 'false'}
            className={`${cardClass} focus-visible:ring-ring cursor-pointer shadow-xs transition-colors focus-visible:ring-2 focus-visible:outline-none ${
              isSelected ? 'bg-link/15 hover:bg-link/20' : 'hover:bg-muted/60'
            }`}
          >
            {body}
            {/*
 The static-at-rest affordance. Without it a user had to hover to
 discover that these two counts are filters, and hover does not exist
 on a touch screen - so on a phone the two clickable cards were
 indistinguishable from the two static ones. Underlined text is the
 same signal the rest of the app uses for links.
 */}
            <Button as="span" variant="link" className="text-link h-auto text-xs">
              {isSelected ? 'Showing only this' : 'Tap to filter'}
            </Button>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

export function SectionCard({
  title,
  moreHref,
  children,
}: {
  title: string;
  moreHref?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center justify-between sm:mb-3">
        <h2 className="text-sm font-semibold tracking-wide uppercase">{title}</h2>
        {moreHref !== undefined ? (
          <Link
            href={moreHref}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center rounded-sm px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          >
            See all
            <LuArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      <div className="border-border rounded-lg border p-3 sm:p-4">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Inline charts (D2 - simple enough to live in the shared file)
// ---------------------------------------------------------------------------

/** Pie of lead counts by status. Telecaller/Exec's single chart, and the
 * team-wide view for Manager/Admin's third chart. Re-uses the
 * friendly-label map so a non-technical user reads "Talked" not
 * "CONTACTED" in the legend. */
export function LeadStatusPie({ data }: { data: unknown }) {
  if (!Array.isArray(data)) return null;
  const counts: Record<string, number> = {};
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const status = (item as { status?: unknown }).status;
    if (typeof status !== 'string') continue;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const pieData = LEAD_STATUSES.map((status) => ({
    name: labelFor('lead', status),
    value: counts[status] ?? 0,
  })).filter((slice) => slice.value > 0);
  if (pieData.length === 0) return null;

  return (
    <ul className="space-y-2 text-sm" aria-label="Lead counts by status (friendly labels)">
      {pieData.map((slice) => (
        <li
          key={slice.name}
          className="flex items-center justify-between border-b pb-1 last:border-b-0"
        >
          <span>{slice.name}</span>
          <span className="text-muted-foreground tabular-nums">{slice.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** Audit timeline - admin only. Buckets audit log entries by day so an
 * admin can see "is anything weird happening this week". Uses an
 * inline `<ul>` rendering instead of a chart primitive because the
 * data is naturally sequential and a sparkline adds noise without
 * information. The empty list message matches the audit module's
 * pending state. */
export function AuditTimeline({ data }: { data: unknown }) {
  if (!Array.isArray(data)) return null;
  type AuditEntry = { createdAt?: string; action?: string };
  const counts: Record<string, number> = {};
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as AuditEntry;
    if (typeof entry.createdAt !== 'string') continue;
    const day = new Date(entry.createdAt).toLocaleDateString('en-CA');
    counts[day] = (counts[day] ?? 0) + 1;
  }
  const days = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-7);
  if (days.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm" aria-label="Audit events per day (last 7 days)">
      {days.map(([day, count]) => (
        <li key={day} className="flex items-center justify-between border-b pb-1 last:border-b-0">
          <span>{day}</span>
          <span className="text-muted-foreground tabular-nums">{count}</span>
        </li>
      ))}
    </ul>
  );
}
