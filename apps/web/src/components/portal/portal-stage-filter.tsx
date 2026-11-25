'use client';

// PortalStageFilter: the chip row above the buyer's feed.
//
// WHAT IT IS (2026-11-25): the counts here are the whole point. "Structure 24"
// tells a buyer how far the build has got without scrolling; the chip also
// narrows the feed to that stage. The feed itself stays one flat, newest-first
// list - see lib/portal-stages.ts for why sections were rejected.
//
// ONE CHIP IS ALWAYS ON. A ToggleGroup reports a press on the active chip as '',
// and an empty filter is a feed that matches nothing, so every refused press
// keeps the current value and the controlled `value` snaps the widget back.
// Same rule as the site filter, same helper shape.
import { ToggleGroup } from '@paalstack/react-ui';

import { nextStageFilter, stageChips, type StageFilter } from '@/lib/portal-stages';
import type { StageCounts } from '@/hooks/queries/customer-portal';

export type PortalStageFilterProps = {
  /** Server counts, undefined while loading. */
  counts: StageCounts | undefined;
  value: StageFilter;
  onChange: (next: StageFilter) => void;
};

export function PortalStageFilter({ counts, value, onChange }: PortalStageFilterProps) {
  const chips = stageChips(counts);
  // Nothing to narrow yet (first load, or a unit with no media at all). A single
  // "All 0" chip would be a control that cannot do anything.
  if (chips.length <= 1) return null;

  return (
    <div
      className="portal-rule-b flex flex-wrap items-center gap-2 pb-3"
      data-qa="portal-stage-filter"
    >
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(next) => {
          const pressed = Array.isArray(next) ? next[0] : next;
          const wanted = nextStageFilter(value, pressed, chips);
          if (wanted !== value) onChange(wanted);
        }}
        items={chips.map((chip) => ({
          value: chip.value,
          content: `${chip.label} ${chip.count}`,
          'data-qa': `portal-stage-${chip.value}`,
          className:
            'rounded-none! border border-[var(--portal-hair)] px-2.5! py-1! text-xs tracking-wide transition-none data-[state=on]:border-[var(--portal-ink)] data-[state=on]:bg-[var(--portal-ink)] data-[state=on]:text-[var(--portal-paper)] aria-pressed:border-[var(--portal-ink)] aria-pressed:bg-[var(--portal-ink)] aria-pressed:text-[var(--portal-paper)]',
        }))}
      />
    </div>
  );
}
