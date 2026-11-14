'use client';

// PortalMilestones: the buyer's checkpoints, in the order staff arranged them.
//
// WHY (2026-11-10): the MilestonesDialog tells the admin "Buyers see these on
// their portal, in this order" - but the portal only ever printed the NEXT one,
// inside the handover band. Every other checkpoint the team wrote was invisible
// to the buyer. A record that hides rows the staff deliberately entered is not
// a record; this renders the whole ladder, once, in staff order.
//
// It replaces the milestone half of PortalHandoverCard rather than joining it:
// both showing "Slab casting" on one screen is the duplication the portal
// redesign removed everywhere else. The handover band keeps the date; this owns
// the checkpoints.
//
// State is carried by TEXT + shape, never colour alone:
//   reached   filled navy square, check glyph, "Reached <date>"
//   next      green square, "Next · target <date>", aria-current="step"
//   upcoming  hairline outline square, "Target <date>" / "Was due <date>"
//
// The list is NOT re-sorted. Staff order is the reading order; sorting by date
// would silently overrule the admin who dragged a row. Target dates that have
// passed are stated as "Was due" - a fact, not an "overdue" verdict the product
// has no basis for (decision #116: never invent a status).
import { LuCheck, LuFlag } from '@paalstack/react-icons/lu';

import { formatDay } from './portal-format';
import { daysUntilDay, milestoneEntries, type MilestoneLike } from './portal-progress';

export type PortalMilestonesProps = {
  milestones: readonly MilestoneLike[];
  /** Injected so SSR and tests agree on "today". */
  now: number;
};

/**
 * The one line under a milestone name. Every row states its status in words, so
 * a buyer never has to infer it from a colour or a fill:
 *   reached   "Reached 1 Oct 2026"
 *   next      "Next · target 20 Dec 2026" / "Next · target not set"
 *   upcoming  "Target 15 Jun 2027"        / "Target not set"
 * A passed target reads "was due" - a fact, not an "overdue" verdict.
 */
export function metaCopy(
  state: 'reached' | 'next' | 'upcoming',
  milestone: MilestoneLike,
  overdue: boolean,
): string {
  if (milestone.completedAt !== null) return `Reached ${formatDay(milestone.completedAt)}`;
  const prefix = state === 'next' ? 'Next · ' : '';
  if (milestone.targetDate === null) return `${prefix}Target not set`;
  return `${prefix}${overdue ? 'Was due' : 'Target'} ${formatDay(milestone.targetDate)}`;
}

export function PortalMilestones({ milestones, now }: PortalMilestonesProps) {
  // Nothing entered is not "0 milestones reached" - it is silence. The handover
  // date speaks for itself; an empty checklist would imply work was planned.
  if (milestones.length === 0) return null;

  const entries = milestoneEntries(milestones);
  const done = entries.filter((e) => e.state === 'reached').length;

  return (
    <section aria-labelledby="portal-milestones-title" data-qa="portal-milestones">
      <div className="portal-rule-b flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pb-2.5">
        <h2
          id="portal-milestones-title"
          className="portal-display flex items-center gap-2 text-[1.375rem] leading-none text-[var(--portal-navy)]"
        >
          <LuFlag className="size-4 shrink-0" aria-hidden="true" />
          Milestones
        </h2>
        <p
          data-qa="portal-milestones-count"
          className="portal-figure text-[0.6875rem] tracking-[0.1em] text-[var(--portal-ink-2)] uppercase"
        >
          {done} of {entries.length} reached
        </p>
      </div>

      <ol className="mt-1">
        {entries.map(({ milestone, state }) => {
          const overdue =
            milestone.completedAt === null &&
            milestone.targetDate !== null &&
            daysUntilDay(milestone.targetDate, now) < 0;

          return (
            <li
              key={milestone.id}
              data-qa="portal-milestone"
              data-state={state}
              aria-current={state === 'next' ? 'step' : undefined}
              className="portal-hairline-b grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-3 py-3 last:border-b-0 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto]"
            >
              <Marker state={state} />

              <div className="min-w-0">
                <p
                  data-qa="portal-milestone-name"
                  className={
                    state === 'upcoming'
                      ? 'text-[0.9375rem] leading-snug text-[var(--portal-ink-2)]'
                      : 'text-[0.9375rem] leading-snug text-[var(--portal-navy)]'
                  }
                >
                  {milestone.name}
                </p>

                {/* The state is stated in words, so it survives greyscale and a
                    screen reader. Colour and fill are decoration on top.
                    Source casing is sentence case; the class uppercases it. */}
                <p
                  data-qa="portal-milestone-meta"
                  className="portal-figure mt-0.5 text-[0.6875rem] tracking-[0.1em] text-[var(--portal-ink-2)] uppercase"
                >
                  {metaCopy(state, milestone, overdue)}
                </p>
              </div>

              {/* Trailing date column: the same figure the row's meta repeats
                  would be noise, so only unfinished rows with a target get a
                  right-aligned date at `sm` and up. */}
              {state === 'next' && milestone.targetDate !== null ? (
                <time
                  dateTime={milestone.targetDate}
                  className="portal-figure hidden text-[0.8125rem] text-[var(--portal-navy)] sm:block"
                >
                  {formatDay(milestone.targetDate)}
                </time>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Square marker. Filled + check when reached, green when next, hairline else. */
function Marker({ state }: { state: 'reached' | 'next' | 'upcoming' }) {
  const base = 'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[2px] border';
  if (state === 'reached') {
    return (
      <span
        aria-hidden="true"
        className={`${base} border-[var(--portal-navy)] bg-[var(--portal-navy)]`}
      >
        <LuCheck className="size-2.5 text-[var(--portal-paper)]" />
      </span>
    );
  }
  if (state === 'next') {
    return (
      <span
        aria-hidden="true"
        className={`${base} border-[var(--portal-green-ink)] bg-[var(--portal-green-wash)]`}
      />
    );
  }
  return <span aria-hidden="true" className={`${base} border-[var(--portal-hair)]`} />;
}
