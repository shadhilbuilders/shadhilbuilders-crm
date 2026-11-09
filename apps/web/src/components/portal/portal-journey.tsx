'use client';

// PortalJourney: "where is my home up to", as a measured ladder rather than a
// nine-row vertical list.
//
// REDESIGN (2026-11-09, third pass). Now a FULL-WIDTH band between the record
// head and the photo plate, instead of a 7-of-12 column. As a column it was
// 612px wide while the photo beneath it was 704px, so the page had two
// different right edges. Full width also buys room for real information: the
// numeral, the stage name, the "updated" age, a done/remaining count, and a
// named tick under each of the nine segments.
//
// States are carried by TEXT + height + aria-current, never colour alone:
//   done     shorter navy bar   "(completed)"  - "Ground" reads "(passed)"
//   current  full-height green  "(current stage)"  aria-current="step"
//   pending  hairline bar       "(upcoming)"
//
// The headline "Stage N of 9" never shows a percentage - the nine stages are
// discrete and stages can move backwards (rework); this product does not invent
// a number. An unrecorded stage reads "Stage not set" and marks nothing done.
import { LuCheck } from '@paalstack/react-icons/lu';

import {
  CONSTRUCTION_STAGE_ORDER,
  constructionStageLabel,
  constructionStageOrUnset,
} from '@/lib/labels';

import { stagePosition, updatedLabel } from './portal-progress';

export type PortalJourneyProps = {
  /** Stage of the newest photo, or null when it recorded none. */
  currentStage: string | null;
  /** When the newest photo was taken; drives the "Updated ..." line. */
  latestTakenAt?: string | null;
  /** Injected so SSR and tests agree on "today". */
  now?: number;
};

type StageState = 'done' | 'current' | 'pending';

const STATE_COPY: Record<StageState, string> = {
  done: ' (completed)',
  current: ' (current stage)',
  pending: ' (upcoming)',
};

/** NOT_STARTED is the baseline before work begins, so calling it "completed"
 *  would be a contradiction ("Not started (completed)"). It reads "passed". */
function stateCopy(stage: string, state: StageState): string {
  if (stage === 'NOT_STARTED' && state === 'done') return ' (passed)';
  return STATE_COPY[state];
}

/** Short names for the ladder's tick labels: the full enum label wraps at nine
 *  equal columns. Text only - the enum is unchanged. */
const TICK_LABEL: Record<string, string> = {
  NOT_STARTED: 'Ground',
  WATERPROOFING: 'Waterproof',
};

const tickLabel = (stage: string): string => TICK_LABEL[stage] ?? constructionStageLabel(stage);

export function PortalJourney({ currentStage, latestTakenAt = null, now }: PortalJourneyProps) {
  const { position, total } = stagePosition(currentStage);
  const currentIndex = position === null ? -1 : position - 1;
  const doneCount = currentIndex < 0 ? 0 : currentIndex;
  const remaining = position === null ? total : total - position;
  return (
    <section aria-labelledby="portal-journey-title" data-qa="portal-stage-stepper">
      {/* ---- summary row: numeral, name, age, counts ---- */}
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {position !== null ? (
            <p
              data-qa="portal-stage-current"
              className="portal-display portal-figure flex items-baseline gap-1.5 text-[clamp(1.75rem,3vw,2.25rem)] leading-none text-[var(--portal-navy)]"
            >
              {String(position).padStart(2, '0')}
              <span className="text-base font-normal tracking-normal text-[var(--portal-ink-2)]">
                / {String(total).padStart(2, '0')}
              </span>
            </p>
          ) : (
            <p
              data-qa="portal-stage-current"
              className="portal-display text-[1.375rem] leading-none text-[var(--portal-navy)]"
            >
              Stage not set
            </p>
          )}
          <h2
            id="portal-journey-title"
            className="text-[0.9375rem] font-medium text-[var(--portal-navy)]"
          >
            {currentStage !== null ? constructionStageLabel(currentStage) : 'Construction journey'}
          </h2>
          {position !== null ? (
            <span
              data-qa="portal-stage-progress"
              className="inline-flex items-center gap-1.5 rounded-sm bg-[var(--portal-green-wash)] px-2 py-0.5 text-[0.625rem] font-medium tracking-[0.12em] text-[var(--portal-green-ink)] uppercase"
            >
              In progress
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[0.6875rem] tracking-[0.1em] text-[var(--portal-ink-2)] uppercase">
          {position !== null ? (
            <p className="portal-figure" data-qa="portal-stage-counts">
              {doneCount} done · 1 in progress · {remaining} left
            </p>
          ) : null}
          {latestTakenAt !== null && now !== undefined ? (
            <p className="portal-figure" data-qa="portal-stage-updated">
              {updatedLabel(latestTakenAt, now)}
            </p>
          ) : null}
        </div>
      </div>

      {/* ---- the ladder: nine named segments, full width ---- */}
      <ol className="portal-ladder mt-4">
        {CONSTRUCTION_STAGE_ORDER.map((stage, index) => {
          const state: StageState =
            index === currentIndex
              ? 'current'
              : currentIndex >= 0 && index < currentIndex
                ? 'done'
                : 'pending';
          return (
            <li
              key={stage}
              data-qa={`portal-stage-segment-${stage.toLowerCase()}`}
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="bar-wrap">
                <span className="bar" />
                {state === 'done' ? <LuCheck className="sr-only" aria-hidden="true" /> : null}
              </span>
              <span className="name portal-figure" aria-hidden="true">
                {tickLabel(stage)}
              </span>
              <span className="sr-only">
                {constructionStageLabel(stage)}
                {stateCopy(stage, state)}
              </span>
            </li>
          );
        })}
      </ol>

      {/* The unrecorded case needs a human sentence somewhere; the ladder alone
          fills nothing and would look blank. */}
      {position === null ? <p className="sr-only">{constructionStageOrUnset(null)}</p> : null}
    </section>
  );
}
