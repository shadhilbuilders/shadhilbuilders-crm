// PortalHandoverCard: what the buyer is waiting for - the expected handover
// date and the next unfinished milestone. Both are STAFF-ENTERED; with neither
// the component renders nothing (an empty card, or an estimate, would be worse
// than silence - decision #116).
//
// REDESIGN (2026-11-09, third pass): full-width band. It previously sat in the
// right 5-of-12 column beside the journey, which put two unrelated subjects
// (construction stage vs. handover date) inside one visual group. As a band of
// spec figures on the page's shared 12-column grid it lines up with the record
// head and the ledger below it.
import { LuFlag, LuKeyRound } from '@paalstack/react-icons/lu';

import { formatDay } from './portal-format';
import { handoverSummary, nextMilestone, type MilestoneLike } from './portal-progress';

export type PortalHandoverCardProps = {
  expectedHandoverDate: string | null;
  milestones: readonly MilestoneLike[];
  now: number;
};

export function PortalHandoverCard({ expectedHandoverDate, milestones, now }: PortalHandoverCardProps) {
  if (expectedHandoverDate === null && milestones.length === 0) return null;

  const handover = expectedHandoverDate === null ? null : handoverSummary(expectedHandoverDate, now);
  const { next, done, total } = nextMilestone(milestones);

  return (
    <section
      aria-label="Handover"
      data-qa="portal-handover"
      className="portal-hairline-b grid grid-cols-1 gap-6 pb-6 sm:grid-cols-2 lg:grid-cols-12 lg:gap-x-8"
    >
      {handover !== null ? (
        <div className="lg:col-span-4">
          <p className="portal-eyebrow mb-2 flex items-center gap-1.5">
            <LuKeyRound className="size-3.5" aria-hidden="true" />
            Expected handover
          </p>
          <p
            className="portal-display portal-figure text-[1.75rem] leading-none text-[var(--portal-navy)]"
            data-qa="portal-handover-date"
          >
            {handover.dateLabel}
          </p>
          {handover.countdown !== null ? (
            <p className="mt-1.5 text-sm text-[var(--portal-ink-2)]">{handover.countdown}</p>
          ) : null}
        </div>
      ) : null}

      {total > 0 ? (
        <div className={handover === null ? 'lg:col-span-6' : 'lg:col-span-5'}>
          <p className="portal-eyebrow mb-2 flex items-center gap-1.5">
            <LuFlag className="size-3.5" aria-hidden="true" />
            {next !== null ? 'Next milestone' : 'Milestones'}
          </p>
          <p
            className="portal-display text-[1.375rem] leading-tight text-[var(--portal-navy)]"
            data-qa="portal-milestone-next"
          >
            {next !== null ? next.name : 'All milestones reached'}
          </p>
          <p className="portal-figure mt-1.5 text-sm text-[var(--portal-ink-2)]">
            {next?.targetDate ? `Target ${formatDay(next.targetDate)} · ` : ''}
            {done} of {total} done
          </p>
        </div>
      ) : null}
    </section>
  );
}
