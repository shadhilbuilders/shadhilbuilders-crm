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
// `IconType` comes from the icon package's root entry (`export * from
// 'react-icons'`), NOT from 'react-icons' directly: that is only a transitive
// dep under pnpm's strict node_modules, so importing it here would be an
// undeclared-dependency error.
import type { IconType } from '@paalstack/react-icons';

// ---------------------------------------------------------------------------
// KPI card tones (2026-09-29, owner request: "all kpi-card with some background
// color with correct icon")
// ---------------------------------------------------------------------------
//
// DESIGN RULE - colour encodes meaning, it does not decorate.
//
// The obvious reading of "give every card a colour" is seven different hues,
// which is the stock "AI dashboard" look: the palette carries no information
// and the eye has to read every label to find the one number that matters.
// This app is a work queue - its whole point is that the urgent count is
// findable at a glance - so the tints are spent on a three-accent palette plus
// a neutral, in the order the counts are already sorted:
//
//   red   = do this now      blue = new / incoming
//   amber = time-bound       neutral = the structural total
//
// The alternative - a different hue per card - gives every number equal visual
// weight, which is the same as giving none of them any.
//
// CONTRAST, measured rather than assumed. The soft tints resolve (on the
// library's white card, via the oklch -> sRGB transform the badge contrast
// test already uses) to:
//
//   bg-destructive-soft #ffe9e6   bg-info-soft #e3f4ff
//   bg-warning-soft     #fff5d7   bg-secondary-soft #e5e7eb
//
// `--muted-foreground` (#64748b) is 4.75:1 on the WHITE card but only
// 4.09-4.35:1 on the warm/cool soft tints - below the 4.5 AA floor for normal
// text. This is the same trap the selected-KPI tint and the overdue queue row
// already hit (see T-DASH-QUEUE-SELECTED below and LeadQueueRow). So on ANY
// tinted card the label and sub-line step up to `text-foreground`: 17.2:1 on the
// destructive tint, 17.7 on info, 18.3 on warning, 16.2 on the neutral. Each
// tone's OWN accent also reads as the icon colour against its tint (all clear
// 4.0:1), and the icon is a redundant cue besides - the glyph carries the
// meaning itself, which is what keeps this WCAG 1.4.1-safe: colour is never the
// only signal.
//
// DARK MODE, measured, and the reason `pipeline` is NEUTRAL rather than another
// hue. The library's `--info/success/warning/destructive-soft` are re-declared
// in `.dark` as dark tints (L~0.23-0.25), so `text-foreground` (near-white) on
// them measures 15.4-15.8:1 and their accents 5.2-7.8:1 - all fine. But
// `--primary-soft` is declared IDENTICALLY in `:root` and `.dark` (oklch
// 0.872 0.061 274.066 - a LIGHT lavender), so in dark mode `text-foreground`
// lands at 1.42:1 on it: effectively invisible. An earlier draft of this
// component used `bg-primary-soft` for the structural tone and would have
// shipped that bug. A four-hue palette therefore cannot be balanced across both
// modes without editing the shared token file, so the structural counts get the
// neutral `secondary-soft` instead (dark tint in dark mode: fg 8.5:1) and the
// palette stays at three accents plus neutral.
//
// ICONS are always `aria-hidden`. The icon repeats what the label already
// says, so announcing it would make a screen reader read the card twice
// ("phone, Needs a call now, 6"). The label is the accessible name; the icon
// is sighted-scanning support. Pinned by dashboard-shared.test.tsx.
export type KpiTone = 'urgent' | 'new' | 'today' | 'pipeline';

const KPI_TONES: Record<
  KpiTone,
  {
    /** The card surface: a soft semantic tint plus the icon's own colour. */
    card: string;
    /** The icon's colour - the accent that makes the tint legible as a category. */
    icon: string;
    /**
     * The label + sub-line colour. `text-foreground` on every tint, because
     * `--muted-foreground` does not clear AA once the card is tinted (measured
     * above). Written explicitly per tone rather than branched inline so a new
     * tone cannot silently inherit the failing token.
     */
    text: string;
  }
> = {
  // Red: "someone is waiting on this". The most urgent count on any screen.
  urgent: {
    card: 'bg-destructive-soft border-destructive/25',
    icon: 'text-destructive',
    text: 'text-foreground',
  },
  // Blue: new / incoming work. Distinct from red - nothing here is overdue yet.
  new: {
    card: 'bg-info-soft border-info/25',
    icon: 'text-info',
    text: 'text-foreground',
  },
  // Amber: dated / time-bound items.
  today: {
    card: 'bg-warning-soft border-warning/30',
    icon: 'text-warning-foreground',
    text: 'text-foreground',
  },
  // Neutral: the structural counts that need no accent at all. Uses the
  // library's `secondary-soft` rather than a fourth hue because it is one of
  // the few soft tokens that is BOTH a light tint in light mode and a dark tint
  // in dark mode (see the DARK MODE note below) - so this tone needs no
  // per-mode special-casing.
  pipeline: {
    card: 'bg-secondary-soft border-border',
    icon: 'text-foreground',
    text: 'text-foreground',
  },
};

/** Renders a KPI's icon at the card's fixed size. Decorative - see above. */
function KpiIcon({ Icon, className }: { Icon: IconType; className: string }) {
  return <Icon className={`size-5 shrink-0 ${className}`} aria-hidden="true" />;
}

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
  /**
   * The card's background tone + its icon. Both are REQUIRED (2026-09-29):
   * an optional tone would let a future call site ship an unstyled card,
   * which is the thing this change exists to prevent. `Icon` takes a
   * react-icons icon TYPE, not an element, so size/colour/aria-hidden stay
   * owned here and a caller cannot ship an unsized or announced icon.
   */
  tone: KpiTone;
  Icon: IconType;
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
        const tone = KPI_TONES[kpi.tone];

        // T-DASH-QUEUE-SELECTED (2026-09-16, user request): a selected filter card
        // reads LIGHT BLUE and nothing else - the tint is the whole visual change.
        //
        // Owner feedback: "border is not needed for selected". The blue border and
        // the blue ring are gone; a selected card keeps the SAME `border-border`
        // every card has, so the four counts stay one visual family and selection
        // does not make one of them look like a different kind of control.
        //
        // COLOUR-MEANING REVISION (2026-09-29). The paragraph above is kept
        // because its reasoning still holds where it applies, but its premise -
        // "the tint is the whole visual change" - is no longer true: every card
        // now carries a semantic tone tint, so a selected card can no longer be
        // distinguished by being the only tinted one. The tint would also FIGHT
        // the tone (a red "urgent" card tinted blue when selected reads as a
        // change of meaning, not a change of filter).
        //
        // So selection is now carried by the two cues that were ALREADY the
        // non-colour ones, promoted from redundant to primary: `aria-pressed`
        // for assistive tech, and the affordance text flipping to "Showing only
        // this" for everyone else. That is a STRONGER signal than the old tint,
        // because it says WHAT is happening, not merely THAT something is. The
        // previous blue tint is dropped (see the button branch below) rather
        // than layered - two tint systems on one card is the kind of
        // decoration-not-information this change set out to remove.
        //
        // CONTRAST, measured not assumed: with every tone's text set to
        // `text-foreground`, the label/sub/placeholder clear AA on all four
        // tints (16.2:1 worst case, the neutral). Previously this only had to
        // hold on the selected card; now it holds on every card unconditionally.
        const secondaryText = tone.text;

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
        //
        // 2026-09-29: `bg-card border-border` is replaced by the tone's own
        // surface + a border in the tone's accent (kept at /25-/30 alpha so the
        // edge reads as part of the tint rather than a second colour). `bg-card`
        // is dropped rather than kept underneath: both are single classes whose
        // position in the generated sheet decides the winner, so relying on
        // source order would be a silent, order-dependent bug. One surface
        // class per card.
        const cardClass = `min-h-11 min-w-0 rounded-lg border p-3 text-left sm:p-4 ${tone.card}`;

        const body = (
          <>
            {/*
              The icon sits in a row with the label. The label is the accessible
              name; the icon is `aria-hidden` (see KpiIcon) because the label
              already says the same thing and a screen reader reading "phone,
              Needs a call now, 6" is noise, not information.

              Colour + glyph together, which is what keeps this WCAG 1.4.1-safe:
              the tint is never the only carrier of the meaning - the glyph is
              the second, non-colour cue, and the label text is a third.
            */}
            <span className="flex items-center gap-2">
              <KpiIcon Icon={kpi.Icon} className={tone.icon} />
              {/* One treatment at every width. The caps were briefly dropped at
                  narrow widths only because a 66px-wide 4-up card could not fit
                  "NEEDS A CALL NOW" (it clipped at four lines, measured). A
                  full-width stacked card fits it comfortably, so the label style
                  no longer changes with the viewport. */}
              <span className={`${secondaryText} block text-xs tracking-wide uppercase`}>
                {kpi.label}
              </span>
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
            // Selection no longer changes the surface (see the T-DASH-QUEUE-SELECTED
            // revision above): the tone owns the background, and the state is
            // carried by `aria-pressed` + the affordance text below. The hover
            // stays, so the card still reads as clickable.
            //
            // `cardClass` already carries `text-left`, but the <button> needs an
            // explicit text COLOUR too: a UA stylesheet sets `color: buttontext`
            // on <button>, and the label/sub spans only set their own colour, so
            // the large VALUE would otherwise fall back to the UA's colour rather
            // than the design token.
            className={`${cardClass} text-foreground focus-visible:ring-ring cursor-pointer shadow-xs transition-colors hover:brightness-95 focus-visible:ring-2 focus-visible:outline-none`}
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
