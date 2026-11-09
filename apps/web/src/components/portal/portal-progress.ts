// Pure helpers behind the redesigned portal (2026-11-09). No React, no Date.now:
// callers inject `now` so tests and SSR agree.
//
// Product rule (plan decision #116): progress is a STAGE COUNT, never an
// invented percentage. `stagePosition` returns null for an unrecorded stage -
// "not recorded" must never read as "stage 1".
import { CONSTRUCTION_STAGE_ORDER } from '@/lib/labels';

import { formatDay } from './portal-format';

const TZ = 'Asia/Kolkata';
const DAY_MS = 86_400_000;

export function stagePosition(stage: string | null): { position: number | null; total: number } {
  const total = CONSTRUCTION_STAGE_ORDER.length;
  if (stage === null) return { position: null, total };
  const index = CONSTRUCTION_STAGE_ORDER.indexOf(stage as never);
  return { position: index === -1 ? null : index + 1, total };
}

/** Whole IST calendar-day number, so "today" follows the buyer's local date. */
function istDayNumber(ms: number): number {
  const ist = new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
  const [y, m, d] = ist.split('-').map(Number);
  return Math.floor(Date.UTC(y as number, (m as number) - 1, d as number) / DAY_MS);
}

export function updatedLabel(iso: string, now: number): string {
  const days = istDayNumber(now) - istDayNumber(new Date(iso).getTime());
  if (days <= 0) return 'Updated today';
  if (days === 1) return 'Updated yesterday';
  if (days < 7) return `Updated ${days} days ago`;
  return `Updated ${formatDay(iso)}`;
}

export type PhaseGroup<T> = { key: string; label: string; rangeLabel: string; photos: T[] };

/** Group a newest-first list into consecutive phase sections. */
export function groupByPhase<T extends { phaseId: string | null; phaseName: string | null; takenAt: string }>(
  photos: readonly T[],
): Array<PhaseGroup<T>> {
  const buckets: Array<{ phaseId: string | null; phaseName: string | null; photos: T[] }> = [];
  for (const photo of photos) {
    const last = buckets[buckets.length - 1];
    if (last !== undefined && last.phaseId === photo.phaseId) {
      last.photos.push(photo);
    } else {
      buckets.push({ phaseId: photo.phaseId, phaseName: photo.phaseName, photos: [photo] });
    }
  }
  return buckets.map((b, i) => {
    const newest = b.photos[0] as T;
    const oldest = b.photos[b.photos.length - 1] as T;
    const from = formatDay(oldest.takenAt);
    const to = formatDay(newest.takenAt);
    return {
      key: `${b.phaseId ?? 'none'}-${i}`,
      label: b.phaseName ?? 'Other updates',
      rangeLabel: from === to ? to : `${from} – ${to}`,
      photos: b.photos,
    };
  });
}

export type MilestoneLike = {
  id: string;
  name: string;
  targetDate: string | null;
  completedAt: string | null;
};

export function nextMilestone<M extends MilestoneLike>(
  milestones: readonly M[],
): { next: M | null; done: number; total: number } {
  return {
    next: milestones.find((m) => m.completedAt === null) ?? null,
    done: milestones.filter((m) => m.completedAt !== null).length,
    total: milestones.length,
  };
}

export function handoverSummary(iso: string, now: number): { dateLabel: string; countdown: string | null } {
  const days = Math.ceil((new Date(iso).getTime() - now) / DAY_MS);
  let countdown: string | null = null;
  if (days >= 60) countdown = `about ${Math.round(days / 30.44)} months to go`;
  else if (days >= 14) countdown = `about ${Math.round(days / 7)} weeks to go`;
  else if (days >= 1) countdown = `${days} ${days === 1 ? 'day' : 'days'} to go`;
  return { dateLabel: formatDay(iso), countdown };
}
