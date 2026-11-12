// Pure helpers for the milestone editor (portal redesign, 2026-11-09). Kept out
// of the component so ordering, date conversion and validation are unit-tested
// without a DOM. A draft is what the form holds; `toPayload` is the wire shape.
import {
  MAX_MILESTONES_PER_PROJECT,
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
  return null;
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
