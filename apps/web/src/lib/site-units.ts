// The site home page's data shaping (2026-11-08).
//
// All of it is pure: counts, filter buckets, phase grouping and the work-queue
// sort are computed here from the rows the API actually returned, and pinned by
// test. Nothing invents a number - a project with no photos reports real zeros.
//
// The server cap is 200 units, and a villa project fits inside it, so these
// counts are computed client-side. When `rows.length === 200` the counts would
// be a LIE (there may be more), so `isCapped` tells the page to say
// "Showing the first 200 units" instead of a number.
import type { UnitRow } from '@/hooks/queries/inventory';
import { constructionStageLabel } from '@/lib/labels';
import {
  stalenessLabel,
  unitPhotoState,
  unitPhotoStateRank,
  type UnitPhotoState,
} from '@/lib/site-photos';

/** The server's `UnitFilterDto` limit cap. */
export const SITE_LIST_CAP = 200;

export type SiteFilter = 'all' | 'needs' | 'updated' | 'none';

export type SiteCounts = {
  /** `none` + `stale`: villas with nothing on file, or nothing recent. */
  needs: number;
  /** `today` + `week`. */
  updated: number;
  /** `none`: never photographed. */
  none: number;
};

/** True when the page is looking at exactly the server's cap of rows. */
export function isCapped(rowCount: number): boolean {
  return rowCount >= SITE_LIST_CAP;
}

export function siteCounts(units: readonly UnitRow[], now: Date): SiteCounts {
  const counts: SiteCounts = { needs: 0, updated: 0, none: 0 };
  for (const unit of units) {
    const state = unitPhotoState(unit, now);
    if (state === 'none') {
      counts.none += 1;
      counts.needs += 1;
    } else if (state === 'stale') {
      counts.needs += 1;
    } else {
      counts.updated += 1;
    }
  }
  return counts;
}

/** Every value the chip row can carry, in render order. */
const SITE_FILTERS = ['all', 'needs', 'updated', 'none'] as const;

/** Narrow an untrusted widget value ("", a stale label) to a real filter. */
export function isSiteFilter(value: string): value is SiteFilter {
  return (SITE_FILTERS as readonly string[]).includes(value);
}

/**
 * The filter a chip press should leave behind (2026-11-24).
 *
 * A single-select toggle lets you press the chip that is ALREADY on, and the
 * widget reports that as an empty value. There is no "no filter" state on this
 * page: an empty filter matches no row at all (`matchesFilter` falls through its
 * switch), so the list would go blank while the counts above it stay full. That
 * is not a state worth offering, so:
 *
 *   - pressing the active chip, or anything the widget invents, changes nothing;
 *   - any other real filter wins.
 *
 * "All" is the way back to the whole list, and it is a chip like the others.
 */
export function nextSiteFilter(
  current: SiteFilter,
  pressed: string | null | undefined,
): SiteFilter {
  if (pressed === null || pressed === undefined || pressed === '') return current;
  if (pressed === current) return current;
  return isSiteFilter(pressed) ? pressed : current;
}

/**
 * The default filter: "Needs a photo" when there is work in that bucket,
 * otherwise All. An empty default filter on a page whose whole job is "which
 * villa have I not been to" would be a wasted tap every visit.
 */
export function defaultSiteFilter(counts: SiteCounts): SiteFilter {
  return counts.needs > 0 ? 'needs' : 'all';
}

function matchesFilter(state: UnitPhotoState, filter: SiteFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'needs':
      return state === 'stale' || state === 'none';
    case 'updated':
      return state === 'today' || state === 'week';
    case 'none':
      return state === 'none';
  }
}

/**
 * Apply the filter, the search and the work-queue sort.
 *
 * Sort: most neglected first (`stale`, then `none`, then `week`, then `today`),
 * and inside a state by unit number so the order is stable between renders.
 * Unit number compares NUMERICALLY where both sides are numeric ("2" before
 * "10"), because that is how the villas are actually named.
 */
export function siteUnits(
  units: readonly UnitRow[],
  opts: { filter: SiteFilter; search: string; now: Date },
): UnitRow[] {
  const needle = opts.search.trim().toLowerCase();
  return units
    .filter((unit) => matchesFilter(unitPhotoState(unit, opts.now), opts.filter))
    .filter((unit) => needle.length === 0 || unit.unitNumber.toLowerCase().includes(needle))
    .slice()
    .sort((a, b) => {
      const byState =
        unitPhotoStateRank(unitPhotoState(a, opts.now)) -
        unitPhotoStateRank(unitPhotoState(b, opts.now));
      if (byState !== 0) return byState;
      return compareUnitNumbers(a.unitNumber, b.unitNumber);
    });
}

/** Natural-ish comparison: numeric prefixes compare as numbers. */
export function compareUnitNumbers(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export type SitePhaseGroup = {
  phaseId: string;
  phaseName: string;
  units: UnitRow[];
};

/**
 * Group the already-sorted rows by phase, keeping the FIRST appearance order of
 * each phase (so the group order follows the work queue, not the alphabet) and
 * the sort inside each group.
 */
export function groupByPhase(units: readonly UnitRow[]): SitePhaseGroup[] {
  const order: string[] = [];
  const byPhase = new Map<string, SitePhaseGroup>();
  for (const unit of units) {
    const existing = byPhase.get(unit.phaseId);
    if (existing !== undefined) {
      existing.units.push(unit);
      continue;
    }
    order.push(unit.phaseId);
    byPhase.set(unit.phaseId, {
      phaseId: unit.phaseId,
      phaseName: unit.phaseName,
      units: [unit],
    });
  }
  return order.map((id) => byPhase.get(id)).filter((g): g is SitePhaseGroup => g !== undefined);
}

/**
 * The phase rail accent, cycling by phase index. This is the ONLY decorative
 * colour in the product: it is stable per phase (the same rail on every visit)
 * and it stays on the rail and the phase heading.
 *
 * The rail is 4px by design (`docs/designs/2026-11-08-site-capture-redesign.prompt.md`).
 * The design detector's `side-tab` rule flags that shape; the waiver and the
 * reason live at the call site in `SiteHome.tsx`, next to the class string.
 */
const PHASE_ACCENTS = ['sky', 'violet', 'teal', 'amber'] as const;
export type PhaseAccent = (typeof PHASE_ACCENTS)[number];

export function phaseAccent(index: number): PhaseAccent {
  return PHASE_ACCENTS[index % PHASE_ACCENTS.length] ?? 'sky';
}

/** The 4px left rail's colour class for an accent. Semantic tokens only. */
export function phaseAccentClass(accent: PhaseAccent): string {
  switch (accent) {
    case 'sky':
      return 'border-l-info';
    case 'violet':
      return 'border-l-primary';
    case 'teal':
      return 'border-l-secondary';
    case 'amber':
      return 'border-l-warning';
  }
}

/**
 * A row's meta line: `3 BHK · East · 3 days ago`, plus the recorded stage when
 * there is one (`3 BHK · East · Structure · 3 days ago`). The stage is TEXT, not
 * another colour: the four documentations states own the row's hue.
 * Facing absent reads "Facing not set" rather than a blank slot.
 */
export function siteRowMeta(unit: UnitRow, now: Date): string {
  const facing = unit.facing ?? 'Facing not set';
  const staleness = stalenessLabel(unit.lastPhotoAt, now).toLowerCase();
  // The newest row of ANY kind that recorded a stage (2026-11-23). Absent when
  // the surface did not load the summary, so it reads as "not recorded" rather
  // than inventing one.
  const stage =
    unit.lastRecordedStage === null || unit.lastRecordedStage === undefined
      ? null
      : constructionStageLabel(unit.lastRecordedStage);
  return [`${unit.bhk} BHK`, facing, ...(stage === null ? [] : [stage]), staleness].join(' · ');
}

/**
 * Whether the two empty states differ, and what each says.
 *
 * A project with no units at all is a different fact from a filter that matched
 * nothing, and telling a user "no villas exist" when they typed a search term
 * is a lie. Both copies live here so the page cannot drift.
 */
export const SITE_EMPTY_COPY = {
  noUnits: {
    title: 'No villas on the board yet',
    body: 'Units appear here once they are added to a phase of this project.',
  },
  /** Engineer with no villas assigned yet (2026-11-10). */
  noAssignments: {
    title: 'No villas assigned to you yet',
    body: 'Your admin assigns villas to you. They will show up here, and you will get a notification.',
  },
  /** Manager whose engineers hold no villas. */
  noManaged: {
    title: 'No villas assigned to your engineers yet',
    body: 'Villas appear here once an admin assigns them to engineers on your teams.',
  },
  filtered: {
    title: 'Nothing in this filter.',
    body: 'Try another filter, or clear the search.',
  },
} as const;

/** Subtitle under "Site updates", per scope: says whose villas these are. */
export const SITE_SCOPE_COPY = {
  ASSIGNED: 'Villas assigned to you',
  MANAGED: 'Villas assigned to engineers on your teams (read-only)',
  ALL: 'Every villa in this project (read-only)',
} as const;

/** The empty-state copy for a scope (admin/owner see the generic one). */
export function siteEmptyCopyFor(scope: 'ASSIGNED' | 'MANAGED' | 'ALL' | null | undefined): {
  title: string;
  body: string;
} {
  if (scope === 'ASSIGNED') return SITE_EMPTY_COPY.noAssignments;
  if (scope === 'MANAGED') return SITE_EMPTY_COPY.noManaged;
  return SITE_EMPTY_COPY.noUnits;
}
