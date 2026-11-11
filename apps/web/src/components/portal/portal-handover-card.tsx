'use client';

// PortalHandoverCard: what the buyer is waiting for - the expected handover
// date. Staff-entered; with no date the component renders nothing (an empty
// card, or an estimate, would be worse than silence - decision #116).
//
// REDESIGN (2026-11-09, third pass): full-width band. It previously sat in the
// right 5-of-12 column beside the journey, which put two unrelated subjects
// (construction stage vs. handover date) inside one visual group.
//
// SCOPE CHANGE (2026-11-10): the milestones half moved OUT, to
// `PortalMilestones`. It used to print only the NEXT checkpoint, so every other
// milestone staff entered was invisible to the buyer - while the admin dialog
// promised "buyers see these, in this order". The card now owns the date alone.
// Mount it only when there IS a date: with the milestones gone it has nothing
// else to say, so the parent owns the null check.
import { LuKeyRound } from '@paalstack/react-icons/lu';

import { handoverSummary } from './portal-progress';

export type PortalHandoverCardProps = {
  /** Never null: the caller renders nothing when staff entered no date. */
  expectedHandoverDate: string;
  now: number;
};

export function PortalHandoverCard({ expectedHandoverDate, now }: PortalHandoverCardProps) {
  const handover = handoverSummary(expectedHandoverDate, now);

  return (
    <section aria-label="Handover" data-qa="portal-handover" className="portal-hairline-b pb-6">
      <div className="max-w-md">
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
    </section>
  );
}
