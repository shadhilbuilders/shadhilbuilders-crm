// Pure helpers for the milestone editor (portal redesign, 2026-11-09). Kept out
// of the component so ordering, date conversion and validation are unit-tested
// without a DOM. A draft is what the form holds; `toPayload` is the wire shape.
import {
  COMPLETED_AT_FUTURE_TOLERANCE_MS,
  MAX_MILESTONES_PER_PROJECT,
  findDuplicateMilestoneName,
  type ProjectMilestoneRow,
  type ReplaceMilestonesDto,
} from '@shadhil/api-types';

export type MilestoneDraft = {
  /** Stable client key (the server id, or a fresh one for a new row). */
  key: string;
  name: string;
  /** `YYYY-MM-DD` or ''. */
  targetDay: string;
  /** `YYYY-MM-DD` or '' (not reached yet). */
  completedDay: string;
};

const toDay = (iso: string | null): string => (iso === null ? '' : iso.slice(0, 10));
const toIso = (day: string): string | null => (day === '' ? null : `${day}T00:00:00.000Z`);

/** Epoch ms for a draft's `YYYY-MM-DD` day, or NaN when the input is not a day. */
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);

export function draftsFromRows(rows: readonly ProjectMilestoneRow[]): MilestoneDraft[] {
  return rows.map((r) => ({
    key: r.id,
    name: r.name,
    targetDay: toDay(r.targetDate),
    completedDay: toDay(r.completedAt),
  }));
}

export function newDraft(key: string): MilestoneDraft {
  return { key, name: '', targetDay: '', completedDay: '' };
}

/** Swap an item with its neighbour; out-of-range moves return the list unchanged. */
export function moveDraft(
  list: readonly MilestoneDraft[],
  index: number,
  delta: -1 | 1,
): MilestoneDraft[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item as MilestoneDraft);
  return next;
}

/** First problem in the list as a plain sentence, or null when it can be saved. */
export function validateDrafts(list: readonly MilestoneDraft[]): string | null {
  if (list.length > MAX_MILESTONES_PER_PROJECT) {
    return `A project can have at most ${MAX_MILESTONES_PER_PROJECT} milestones.`;
  }
  const blank = list.findIndex((d) => d.name.trim().length === 0);
  if (blank !== -1) return `Milestone ${blank + 1} needs a name.`;
  const tooLong = list.findIndex((d) => d.name.trim().length > 80);
  if (tooLong !== -1) return `Milestone ${tooLong + 1} has a name over 80 characters.`;

  // Same rule the DTO enforces, so the user hears about it before hitting Save.
  const duplicate = findDuplicateMilestoneName(list.map((d) => d.name));
  if (duplicate !== null) {
    return `Milestone ${duplicate.index + 1} repeats the name "${duplicate.name}". Give each one a different name.`;
  }

  const badDate = list.findIndex(
    (d) => d.completedDay !== '' && Number.isNaN(dayMs(d.completedDay)),
  );
  if (badDate !== -1) return `Milestone ${badDate + 1} has an invalid completion date.`;
  const future = list.findIndex(
    (d) =>
      d.completedDay !== '' &&
      dayMs(d.completedDay) > Date.now() + COMPLETED_AT_FUTURE_TOLERANCE_MS,
  );
  if (future !== -1) return `Milestone ${future + 1} cannot be marked reached with a future date.`;

  return null;
}

/**
 * Non-blocking note: a completion date earlier than the target date is allowed
 * (targets get revised after the fact) but is usually a typo, so the editor
 * shows it without refusing the save.
 */
export function warnDrafts(list: readonly MilestoneDraft[]): string | null {
  const index = list.findIndex(
    (d) => d.completedDay !== '' && d.targetDay !== '' && d.completedDay < d.targetDay,
  );
  if (index === -1) return null;
  return `Milestone ${index + 1} was completed before its target date. Check the target date if that was not intended.`;
}

export function toPayload(list: readonly MilestoneDraft[]): ReplaceMilestonesDto {
  return {
    milestones: list.map((d) => ({
      name: d.name.trim(),
      targetDate: toIso(d.targetDay),
      completedAt: toIso(d.completedDay),
    })),
  };
}

/**
 * True when the editor still holds exactly what `rows` seeded it with: same
 * length, same order, same fields. Client keys are ignored because they are
 * not user input. Used to decide whether a refetch may replace the drafts.
 */
export function isUntouched(
  drafts: readonly MilestoneDraft[],
  rows: readonly ProjectMilestoneRow[],
): boolean {
  const seeded = draftsFromRows(rows);
  if (drafts.length !== seeded.length) return false;
  return drafts.every((d, i) => {
    const s = seeded[i] as MilestoneDraft;
    return d.name === s.name && d.targetDay === s.targetDay && d.completedDay === s.completedDay;
  });
}

export type EmptyConfirmCopy = {
  title: string;
  description: string;
  confirmLabel: string;
};

/** Copy for the "save an empty list" confirmation, singular for one milestone. */
export function emptyConfirmCopy(count: number): EmptyConfirmCopy {
  if (count === 1) {
    return {
      title: 'Delete the milestone?',
      description:
        'This removes the milestone from this project, and buyers stop seeing any checkpoint on their portal.',
      confirmLabel: 'Delete it',
    };
  }
  return {
    title: 'Delete all milestones?',
    description: `This removes all ${count} milestones from this project, and buyers stop seeing any checkpoints on their portal.`,
    confirmLabel: 'Delete them',
  };
}
