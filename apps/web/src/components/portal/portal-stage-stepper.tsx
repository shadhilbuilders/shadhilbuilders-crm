'use client';

// PortalStageStepper (2026-11-08): the buyer's progress line.
//
// WHAT IT SHOWS: nine segments in enum order, with the current one filled, and
// the current stage named beside it. The current stage is the stage recorded on
// the NEWEST photo - derived, never stored on the unit.
//
// WHAT IT REFUSES TO SHOW: a percentage. "62% complete" would be invented from
// nine discrete stages, and this product does not lie about progress. A stage
// can go backwards (rework happens); the stepper just moves back.
//
// A unit whose newest photo recorded no stage reads "Stage not set" and fills
// nothing. It never falls back to "Not started" - that is a guess dressed as
// data.
import { LuCheck } from '@paalstack/react-icons/lu';

import {
  CONSTRUCTION_STAGE_ORDER,
  constructionStageLabel,
  constructionStageOrUnset,
} from '@/lib/labels';

export type PortalStageStepperProps = {
  /** Stage of the newest photo, or null when it recorded none. */
  currentStage: string | null;
};

export function PortalStageStepper({ currentStage }: PortalStageStepperProps) {
  const currentIndex =
    currentStage === null ? -1 : CONSTRUCTION_STAGE_ORDER.indexOf(currentStage as never);

  return (
    <section
      aria-label="Construction stage"
      data-qa="portal-stage-stepper"
      className="border-border rounded-lg border p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-muted-foreground text-base">Construction stage</p>
        <p className="text-foreground text-base font-semibold" data-qa="portal-stage-current">
          {constructionStageOrUnset(currentStage)}
        </p>
      </div>

      <ol className="mt-3 flex items-center gap-1" aria-hidden="true">
        {CONSTRUCTION_STAGE_ORDER.map((stage, index) => {
          const done = currentIndex >= 0 && index < currentIndex;
          const current = index === currentIndex;
          return (
            <li
              key={stage}
              data-qa={`portal-stage-segment-${stage.toLowerCase()}`}
              data-state={current ? 'current' : done ? 'done' : 'pending'}
              className={
                current
                  ? 'bg-primary h-2 flex-1 rounded-full'
                  : done
                    ? 'bg-primary/50 h-2 flex-1 rounded-full'
                    : 'bg-muted-soft h-2 flex-1 rounded-full'
              }
            >
              <span className="sr-only">
                {constructionStageLabel(stage)}
                {current ? ' (current stage)' : ''}
              </span>
            </li>
          );
        })}
      </ol>

      {/* The words are the real signal: the bar is decorative for a screen
          reader, and colour alone is never the only carrier. */}
      {currentStage !== null ? (
        <p className="text-muted-foreground mt-3 flex items-center gap-1.5 text-sm">
          <LuCheck className="size-4" aria-hidden="true" />
          {constructionStageLabel(currentStage)}
        </p>
      ) : (
        <p className="text-muted-foreground mt-3 text-sm">
          The team has not recorded a stage yet.
        </p>
      )}
    </section>
  );
}
