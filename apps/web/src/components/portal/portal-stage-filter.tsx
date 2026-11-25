'use client';

// PortalStageFilter: the stage chips above the buyer's feed.
//
// WHAT IT IS (2026-11-25): the counts are the point. "Structure 24" tells a buyer
// how far the build has got without scrolling, and the chip narrows the feed.
// The feed stays one flat newest-first list - see lib/portal-stages.ts for why
// sections were rejected.
//
// TYPE AND RULES: this is a CONTROL, not a section head, so it does not carry
// `portal-rule-b`. That weight belongs to the phase header directly below, and
// two rules ~12px apart was the clutter. It sits on the page with air instead:
// no rule of its own, `pb-5` underneath so the header rule has room, and
// micro-label type so it reads as a filter strip, not body copy.
//
// THE SCROLL LIVES ON THE WRAPPER (measured, not assumed): the library's
// ToggleGroup root ships its own `w-fit flex` and drops the className it is
// given - the passed class never reached the DOM - so an overflow rule placed
// there is dead. Below `sm` the wrapper scrolls edge to edge with the scrollbar
// hidden; from `sm` it overflows visibly, which is fine because the strip fits.
//
// IT STARTS AT THE LEFT (2026-11-25, fourth pass). Radix scrolls the checked item
// into view on mount, so the strip opened scrolled PAST "All": the selected chip
// was off-screen and the row looked like it had no selection at all. The wrapper
// resets its scroll on mount, once the chips exist.
//
// ONE CHIP IS ALWAYS ON. A ToggleGroup reports a press on the active chip as '',
// and an empty filter matches nothing, so every refused press keeps the current
// value and the controlled `value` snaps the widget back.
import { ToggleGroup } from '@paalstack/react-ui';
import { useEffect, useRef } from 'react';

import { nextStageFilter, stageChips, type StageFilter } from '@/lib/portal-stages';
import type { StageCounts } from '@/hooks/queries/customer-portal';

export type PortalStageFilterProps = {
  /** Server counts, undefined while loading. */
  counts: StageCounts | undefined;
  value: StageFilter;
  onChange: (next: StageFilter) => void;
};

export function PortalStageFilter({ counts, value, onChange }: PortalStageFilterProps) {
  const strip = useRef<HTMLDivElement | null>(null);
  const chips = stageChips(counts);

  useEffect(() => {
    if (strip.current !== null) strip.current.scrollLeft = 0;
  }, []);

  // Nothing to narrow yet (first load, or a unit with no media at all). A single
  // "All 0" chip would be a control that cannot do anything.
  if (chips.length <= 1) return null;

  return (
    <div
      ref={strip}
      className="-mx-4 flex [scrollbar-width:none] items-center overflow-x-auto px-4 pt-1 pb-5 sm:mx-0 sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden"
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
          content: (
            <span className="flex items-baseline gap-1.5">
              <span>{chip.label}</span>
              <span className="portal-figure opacity-70">{chip.count}</span>
            </span>
          ),
          'aria-label': `${chip.label}, ${chip.count} ${chip.count === 1 ? 'item' : 'items'}`,
          'data-qa': `portal-stage-${chip.value}`,
          // Resting chips sit on `--secondary`, the design system's neutral for a
          // resting control, not the page's `--portal-tint`: a filter chip is a
          // control and the two differ in the light theme (#f2f2f0 vs #f7f7f5),
          // where the tint is too close to paper to read as something you press.
          // In dark mode they are the same value, so nothing shifts there.
          //
          // The checked one is a GREEN block (owner ruling, 2026-11-25: the
          // selected filter takes the brand green) with navy type, because white
          // on #63B233 is 2.64:1 and navy on it is 6.32:1 - the token
          // --portal-on-green carries that decision. `--secondary` cannot serve
          // here and neither can `--success`, which is #3f7419, a dark green ink
          // for type, not the brand green as a fill.
          //
          // THE STATE UTILITIES CARRY `!` ON PURPOSE (measured): this widget
          // reports its checked state as `aria-pressed`, and the library's own
          // pressed styles beat a plain utility of equal specificity. Without
          // the bang the checked chip rendered transparent - it looked like an
          // empty gap at the start of the row, which is exactly how the strip
          // read as having no selection at all.
          //
          // The gap is a margin on each item, not `gap` on the group: the group
          // root takes its spacing from a `--gap` var set by its own `spacing`
          // prop, so a class here cannot add one.
          className:
            'mr-1.5 h-auto! min-h-10 min-w-0! shrink-0! rounded-none! border border-[var(--portal-ink-2)]/35 bg-[var(--secondary)] px-3! py-2! text-[0.6875rem] font-medium tracking-[0.06em] whitespace-nowrap text-[var(--portal-navy)] uppercase shadow-none! transition-none last:mr-0 hover:border-[var(--portal-navy)] hover:bg-[var(--secondary)] aria-pressed:border-[var(--portal-green-ink)]! aria-pressed:bg-[var(--portal-green)]! aria-pressed:text-[var(--portal-on-green)]! aria-pressed:[&_span]:text-[var(--portal-on-green)]!',
        }))}
      />
    </div>
  );
}
