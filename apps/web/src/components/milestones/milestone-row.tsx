'use client';

// MilestoneRow: one editable checkpoint inside MilestonesDialog. Split out so
// the row can be rendered and asserted without a query client or an open dialog.
//
// ALIGNMENT FIX (2026-11-10). Two defects, both measured on the shipped dialog:
//
//  1. RAGGED LEFT EDGE. The numeral lived INSIDE the name row's flex line, so
//     the name field began 28px (`w-5` numeral + `gap-2`) to the right of the
//     two date fields stacked below it. At 1x that read name input x=47.2 vs
//     date inputs x=19.2 - two different left edges inside one card. The
//     numeral is a ROW marker, not part of the name field, so it now owns its
//     own 20px gutter column on the row and every field shares one left rail.
//
//  2. FIELD SAT HIGH. `className` on the library Input lands on its OUTER
//     wrapper (`flex flex-col gap-2`), not the `<input>`. So `min-h-11` made
//     the wrapper 44px while the real field stayed `h-8` (32px), pinned to the
//     top of that box - its centre sat ~6px above the 44px icon buttons' centre,
//     with dead space underneath. The height now goes through `inputClassName`,
//     which reaches the element, so the field and the controls share a centre.
//
// Mobile-first: 44px controls, one card per milestone, dates stack under `sm`.
import { useId } from 'react';

import { IconButton, Input } from '@paalstack/react-ui';
import { LuArrowDown, LuArrowUp, LuTrash2 } from '@paalstack/react-icons/lu';

import type { MilestoneDraft } from './milestone-draft';

export type MilestoneRowProps = {
  draft: MilestoneDraft;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<MilestoneDraft>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
};

/** 36px height, applied to the <input> itself (see note 2 above). */
const FIELD = 'min-h-9';

export function MilestoneRow({
  draft,
  index,
  isFirst,
  isLast,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: MilestoneRowProps) {
  const position = index + 1;
  const idBase = useId();
  const nameId = `${idBase}-name`;
  const targetId = `${idBase}-target`;
  const doneId = `${idBase}-done`;

  return (
    <li data-qa="milestone-row" className="border-border rounded-lg border p-3">
      {/* Gutter + fields. The numeral is a sibling of the whole field stack, so
          it cannot indent one field differently from the others. */}
      <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-2">
        <span
          aria-hidden="true"
          className="text-muted-foreground flex h-11 items-center text-sm tabular-nums"
        >
          {position}
        </span>

        <div className="min-w-0 space-y-2" data-qa="milestone-fields">
          {/* MOBILE (2026-11-11). Measured at 320px, three inline 44px controls
              squeezed the name field to 76px - about five characters, on the one
              device where typing a milestone name is hardest.
              The fix is FLUID, not a `sm:` breakpoint: this app overrides
              Tailwind's scale (xs=481, sm=768, md=992, lg=1200), so a `sm:`
              flip would leave 640-767px with a 700px dialog and needlessly
              wrapped controls. Instead the actions are `shrink-0` and the name
              field refuses to go below 12rem, so `flex-wrap` keeps them inline
              whenever both fit and drops the controls to their own line when
              they do not. The controls stay 44px at every width. */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={nameId}
              aria-label={`Milestone ${position} name`}
              placeholder="Slab cast"
              maxLength={80}
              value={draft.name}
              onChange={(e) => onChange({ name: e.target.value })}
              className="min-w-0 grow basis-[16rem]"
              inputClassName={FIELD}
            />
            <div
              data-qa="milestone-actions"
              className="ml-auto flex shrink-0 items-center justify-end gap-2"
            >
              <IconButton
                icon={<LuArrowUp className="size-4" />}
                aria-label={`Move milestone ${position} up`}
                variant="ghost"
                className="size-11 shrink-0"
                disabled={isFirst}
                onClick={onMoveUp}
              />
              <IconButton
                icon={<LuArrowDown className="size-4" />}
                aria-label={`Move milestone ${position} down`}
                variant="ghost"
                className="size-11 shrink-0"
                disabled={isLast}
                onClick={onMoveDown}
              />
              <IconButton
                icon={<LuTrash2 className="size-4" />}
                aria-label={`Remove milestone ${position}`}
                variant="ghost"
                color="danger"
                className="size-11 shrink-0"
                onClick={onRemove}
              />
            </div>
          </div>

          {/* Same fluid reasoning as the actions row: `sm:grid-cols-2` would
              flip at this app's 768px, so a 700px-wide dialog at 767px stacked
              two date fields that both fit. `auto-fit` with a 11rem floor puts
              them side by side the moment each has room, and stacks them when
              they do not - no breakpoint to keep in sync with the theme. */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-2">
            <label htmlFor={targetId} className="text-muted-foreground space-y-1 text-xs">
              Target date
              <Input
                id={targetId}
                type="date"
                value={draft.targetDay}
                onChange={(e) => onChange({ targetDay: e.target.value })}
                inputClassName={FIELD}
              />
            </label>
            <label htmlFor={doneId} className="text-muted-foreground space-y-1 text-xs">
              Reached on (blank = not yet)
              <Input
                id={doneId}
                type="date"
                value={draft.completedDay}
                onChange={(e) => onChange({ completedDay: e.target.value })}
                inputClassName={FIELD}
              />
            </label>
          </div>
        </div>
      </div>
    </li>
  );
}
