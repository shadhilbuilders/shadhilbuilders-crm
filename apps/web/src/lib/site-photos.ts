// Pure helpers behind the site-staff surface (2026-11-08).
//
// Everything here is derived from a REAL timestamp on a real row: the site home
// page's four documentation states, the staleness phrase, the work-queue sort,
// and the one-line summary above the capture feed. Nothing is invented and
// nothing reads the clock on its own - `now` is always passed in, so every
// boundary is testable without freezing time.
//
// The four states are the ONLY colour on the page. Each one also carries a
// label in words, because colour alone fails WCAG 1.4.1 and a colour-blind
// engineer standing in sunlight is a real user.

import type { UnitRow } from '@/hooks/queries/inventory';

/** Four documentation states, each derived from a timestamp. */
export type UnitPhotoState = 'none' | 'today' | 'week' | 'stale';

/** "today" covers the last 2 days, "week" 3 to 7 days, "stale" beyond that. */
const TODAY_MAX_DAYS = 2;
const WEEK_MAX_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole-day boundary tests expressed as elapsed milliseconds. */
function daysSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / MS_PER_DAY;
}

/**
 * The unit's documentation state.
 *
 * A `lastPhotoAt` in the FUTURE is treated as `today`: a phone with a skewed
 * clock must never produce "needs a photo" for a villa photographed this
 * morning. `photoCount === 0` wins over everything - no timestamp can be more
 * meaningful than "nothing on file".
 */
export function unitPhotoState(
  unit: Pick<UnitRow, 'photoCount' | 'lastPhotoAt'>,
  now: Date,
): UnitPhotoState {
  if (unit.photoCount === 0 || unit.lastPhotoAt === null) return 'none';
  const days = daysSince(unit.lastPhotoAt, now);
  if (days <= TODAY_MAX_DAYS) return 'today';
  if (days <= WEEK_MAX_DAYS) return 'week';
  return 'stale';
}

/**
 * The work queue order: most neglected first. `stale` before `none` because a
 * villa photographed a month ago is a worse gap than one never photographed at
 * all (the latter is known work not yet started, the former looks done).
 */
export function unitPhotoStateRank(state: UnitPhotoState): number {
  switch (state) {
    case 'stale':
      return 0;
    case 'none':
      return 1;
    case 'week':
      return 2;
    case 'today':
      return 3;
  }
}

/** The state's own words. Never render the state as colour alone. */
export function unitPhotoStateLabel(state: UnitPhotoState): string {
  switch (state) {
    case 'none':
      return 'No photos';
    case 'today':
      return 'Updated today';
    case 'week':
      return 'This week';
    case 'stale':
      return 'Needs a photo';
  }
}

/**
 * Badge variant for a state. Mapped here rather than inline so the home page's
 * badge and any other surface cannot disagree about what "stale" looks like.
 */
export function unitPhotoStateBadgeVariant(
  state: UnitPhotoState,
): 'muted' | 'success' | 'info' | 'warning' {
  switch (state) {
    case 'none':
      return 'muted';
    case 'today':
      return 'success';
    case 'week':
      return 'info';
    case 'stale':
      return 'warning';
  }
}

/** Tinted surface for the media square / stat tile. Semantic tokens only. */
export function unitPhotoStateSurface(state: UnitPhotoState): string {
  switch (state) {
    case 'none':
      return 'bg-muted-soft text-muted-foreground';
    case 'today':
      return 'bg-success-soft text-success-soft-fg';
    case 'week':
      return 'bg-info-soft text-info-soft-fg';
    case 'stale':
      return 'bg-warning-soft text-warning-soft-fg';
  }
}

/** Pad to two digits for a clock reading. */
function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Local calendar day key, so "today" means the user's today, not UTC's. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function clockTime(d: Date): string {
  const hours24 = d.getHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const meridiem = hours24 < 12 ? 'am' : 'pm';
  return `${hours12}:${two(d.getMinutes())} ${meridiem}`;
}

/**
 * When a photo was taken, in words: `Today, 4:12 pm` / `Yesterday, 9:05 am` /
 * `3 Nov 2026`. The year is included only when it differs from now, so a feed
 * of this year's work does not repeat "2026" on every row.
 *
 * Computed from LOCAL calendar days rather than a millisecond delta: a photo
 * taken at 11:50 pm is "today" for ten minutes and then "yesterday", which is
 * what a person means by the word.
 */
export function relativeCaptureTime(iso: string, now: Date): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';

  const todayKey = dayKey(now);
  const whenKey = dayKey(when);
  if (whenKey === todayKey) return `Today, ${clockTime(when)}`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (whenKey === dayKey(yesterday)) return `Yesterday, ${clockTime(when)}`;

  const day = when.getDate();
  const month = MONTHS_SHORT[when.getMonth()] ?? '';
  return when.getFullYear() === now.getFullYear()
    ? `${day} ${month}`
    : `${day} ${month} ${when.getFullYear()}`;
}

/**
 * The staleness phrase used in a row's meta line ("3 days ago"). Separate from
 * {@link relativeCaptureTime}: one is an exact reading, the other is a duration.
 * A future timestamp reads "just now" - never "-2 days ago".
 */
export function stalenessLabel(lastPhotoAt: string | null, now: Date): string {
  if (lastPhotoAt === null) return 'No photos yet';
  const days = Math.floor(daysSince(lastPhotoAt, now));
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

/** The one-line summary above the capture feed: `8 photos · last added today`. */
export function photoSummaryLine(photos: readonly { takenAt: string }[], now: Date): string | null {
  if (photos.length === 0) return null;
  const first = photos[0];
  if (first === undefined) return null;
  const count = photos.length === 1 ? '1 photo' : `${photos.length} photos`;
  return `${count} · last added ${stalenessLabel(first.takenAt, now).toLowerCase()}`;
}

/**
 * Toggle a quick-note chip's line inside the note text.
 *
 * The textarea is the SINGLE SOURCE OF TRUTH for the note; chips are a
 * keyboard-free shortcut that append or remove one whole line. Rules:
 *   - selecting appends the label as its own line (never a duplicate),
 *   - deselecting removes every line that is exactly that label,
 *   - the order of the remaining lines is preserved untouched.
 */
export function toggleNoteLine(note: string, label: string, selected: boolean): string {
  const lines = note.split('\n');
  const without = lines.filter((line) => line.trim() !== label);
  if (!selected) return without.join('\n').trim();
  // Append after the last non-empty line so an empty note does not start with a
  // blank row.
  const trimmed = without.join('\n').replace(/\s+$/, '');
  return trimmed.length === 0 ? label : `${trimmed}\n${label}`;
}

/** The quick-note chips offered at capture time, in display order. */
export const QUICK_NOTE_LABELS = [
  'Slab',
  'Brickwork',
  'Plastering',
  'Waterproofing',
  'Flooring',
  'Issue',
] as const;
export type QuickNoteLabel = (typeof QUICK_NOTE_LABELS)[number];

/** Slug used in `data-qa="site-note-chip-{slug}"`. */
export function quickNoteSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
