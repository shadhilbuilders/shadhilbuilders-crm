// Grouping the buyer's progress feed by construction stage (2026-11-25).
//
// The feed itself stays ONE flat, newest-first list. "Grouping" here means the
// buyer picks a stage and the list narrows to it, with the real per-stage totals
// on the chips so the ladder doubles as a progress summary. Sections were the
// other option and were rejected on purpose: the timeline is cursor-paginated, so
// true sections need one cursor per stage, and pretending to group the pages that
// happen to be loaded shows the same stage twice with a heading that lies.
//
// Two rules, both learned in this repo:
//   1. Exactly one chip is always on. A ToggleGroup reports a press on the active
//      chip as '', and an empty value would mean "no filter" to some widgets and
//      "nothing matches" to others. Pressing the active chip is a no-op; 'All' is
//      the way back. Same rule as the site filter (nextSiteFilter).
//   2. A capture that recorded no stage is its own bucket, labelled "Stage not
//      set". It is never folded into NOT_STARTED: one means "the engineer did not
//      say", the other means "the site has not begun", and a buyer reading their
//      own build deserves the difference.
import type { ConstructionStage } from '@shadhil/api-types';

import { constructionStageLabel } from '@/lib/labels';

/** What the feed is filtered by: everything, one stage, or the unlabelled bucket. */
export type StageFilter = 'all' | 'UNSET' | ConstructionStage;

/** One chip: its value, its label, and the server's total for it. */
export type StageChip = {
  value: StageFilter;
  label: string;
  count: number;
};

/** The counts the server returns, as this module needs them. */
export type StageCountsInput = {
  stages: readonly { stage: ConstructionStage; count: number }[];
  unset: number;
  total: number;
};

/** The total across every bucket, so a caller can decide whether to render at all. */
export function totalItems(counts: StageCountsInput | undefined): number {
  return counts?.total ?? 0;
}

/**
 * The chip row for these counts: 'All' first, then the stages in the order the
 * server sent them (build order), then "Stage not set" when anything recorded
 * none.
 *
 * Stages with a zero count are omitted: a chip that always shows 0 is a promise
 * the feed cannot keep, and the totals exist to say what IS there. The server
 * already sorts, so this function never re-sorts; two orderings is how a ladder
 * ends up starting with Finishing on one device and Foundation on another.
 */
export function stageChips(counts: StageCountsInput | undefined): StageChip[] {
  const all: StageChip = { value: 'all', label: 'All', count: counts?.total ?? 0 };
  if (counts === undefined) return [all];
  const chips: StageChip[] = [all];
  for (const row of counts.stages) {
    if (row.count <= 0) continue;
    chips.push({ value: row.stage, label: constructionStageLabel(row.stage), count: row.count });
  }
  if (counts.unset > 0) {
    chips.push({ value: 'UNSET', label: 'Stage not set', count: counts.unset });
  }
  return chips;
}

/**
 * The filter after a chip press.
 *
 * Returns `current` unchanged when the press should be ignored: a press on the
 * chip that is already on (the widget reports it as ''), or a value that is not
 * one of the chips actually offered. Anything else becomes the new filter, so the
 * controlled component's `value` snaps a refused press straight back.
 */
export function nextStageFilter(
  current: StageFilter,
  pressed: string | undefined,
  offered: readonly { value: StageFilter }[],
): StageFilter {
  if (pressed === undefined || pressed.length === 0) return current;
  if (pressed === current) return current;
  const match = offered.find((chip) => chip.value === pressed);
  return match === undefined ? current : match.value;
}

/**
 * The filter to actually query with.
 *
 * A deep link wins (2026-11-25): the WhatsApp button carries `?photo=<id>`, and if
 * the buyer had a stage chip on, that photo is very likely not in the narrowed
 * list, so the lightbox would never open the one thing the message was about. The
 * deep link resolves first and the filter applies again once it is done.
 */
export function effectiveStageFilter(
  chosen: StageFilter,
  deepLinkPhotoId: string | null,
): StageFilter {
  return deepLinkPhotoId === null ? chosen : 'all';
}
