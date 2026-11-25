'use client';

// PortalStageFilter: the stage chips above the buyer's feed.
//
// WHAT IT IS (2026-11-25): the counts are the point. "Structure 24" tells a buyer
// how far the build has got without scrolling, and the chip narrows the feed.
// The feed stays one flat newest-first list - see lib/portal-stages.ts for why
// sections were rejected.
//
// TYPE AND RULES (2026-11-25, second pass): this is a CONTROL, not a section
// head, so it does not carry `portal-rule-b`. That weight belongs to the phase
// header directly below, and two rules ~12px apart was the clutter. It sits on
// the page with air instead: no border, `pb-5` underneath so the phase rule has
// room, and micro-label type so it reads as a filter strip, not body copy.
//
// THE STRIP DOES NOT WRAP ON A PHONE (2026-11-25, third pass). Measured at
// 430px: six chips need ~560px and the ToggleGroup is ONE flex item, so `flex-
// wrap` on the wrapper did nothing and the last chips were clipped off the right
// edge with no way to reach them. Below `sm` it is a single horizontally
// scrollable row, edge to edge, scrollbar hidden; from `sm` it wraps normally.
//
// ONE CHIP IS ALWAYS ON. A ToggleGroup reports a press on the active chip as '',
// and an empty filter matches nothing, so every refused press keeps the current
// value and the controlled `value` snaps the widget back.
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
    <div className="-mx-4 flex items-center pt-1 pb-5 sm:mx-0" data-qa="portal-stage-filter">
      <ToggleGroup
        type="single"
        value={value}
        // One row that scrolls on a phone, wraps from sm. `w-full` so the strip
        // owns the bleed and the chips can run past the gutter.
        className="w-full [scrollbar-width:none] flex-nowrap items-center gap-x-1.5 overflow-x-auto px-4 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden"
        onValueChange={(next) => {
          const pressed = Array.isArray(next) ? next[0] : next;
          const wanted = nextStageFilter(value, pressed, chips);
          if (wanted !== value) onChange(wanted);
        }}
        items={chips.map((chip) => ({
          value: chip.value,
          content: (
            <span className="flex items-baseline gap-1.5">
              <span>{chip.label}</span>
              <span className="portal-figure text-[0.6875rem] opacity-55">{chip.count}</span>
            </span>
          ),
          'aria-label': `${chip.label}, ${chip.count} ${chip.count === 1 ? 'item' : 'items'}`,
          'data-qa': `portal-stage-${chip.value}`,
          // Square, hairline, no radius and no shadow: the two weights the rest
          // of the portal uses. Selected inverts to ink on paper.
          className:
            'h-auto! min-w-0! shrink-0! rounded-none! border border-[var(--portal-hair)] bg-transparent px-3! py-2! text-[0.6875rem] font-medium tracking-[0.08em] whitespace-nowrap uppercase shadow-none! transition-none hover:border-[var(--portal-ink)] hover:bg-transparent data-[state=on]:border-[var(--portal-ink)] data-[state=on]:bg-[var(--portal-ink)] data-[state=on]:text-[var(--portal-paper)] aria-pressed:border-[var(--portal-ink)] aria-pressed:bg-[var(--portal-ink)] aria-pressed:text-[var(--portal-paper)]',
        }))}
      />
    </div>
  );
}
