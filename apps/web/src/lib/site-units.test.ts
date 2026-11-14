import { describe, expect, it } from 'vitest';

import type { UnitRow } from '@/hooks/queries/inventory';
import {
  compareUnitNumbers,
  defaultSiteFilter,
  groupByPhase,
  isCapped,
  phaseAccent,
  siteCounts,
  siteEmptyCopyFor,
  SITE_SCOPE_COPY,
  siteRowMeta,
  SITE_EMPTY_COPY,
  SITE_LIST_CAP,
  siteUnits,
} from './site-units';

const NOW = new Date('2026-11-08T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

/** A real-shaped row: only the fields the home page reads are meaningful. */
function unit(over: Partial<UnitRow> & { unitNumber: string }): UnitRow {
  return {
    id: `unit-${over.unitNumber}`,
    phaseId: 'phase-b',
    phaseName: 'Phase B',
    projectId: 'proj-1',
    projectName: 'Metro Heights',
    bhk: 3,
    facing: 'East',
    plotNumber: null,
    sqft: 1200,
    buildupSqft: '1450',
    pricePerSqft: '4000',
    price: '5800000',
    status: 'AVAILABLE',
    lastPhotoAt: null,
    photoCount: 0,
    lastPhotoStage: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const FRESH = unit({ unitNumber: 'B-101', photoCount: 2, lastPhotoAt: ago(0) });
const WEEK = unit({ unitNumber: 'B-102', photoCount: 1, lastPhotoAt: ago(4) });
const STALE = unit({ unitNumber: 'B-103', photoCount: 6, lastPhotoAt: ago(30) });
const NONE = unit({ unitNumber: 'B-104' });

describe('siteCounts', () => {
  it('reports the three real numbers, with no overlap between tiles', () => {
    const counts = siteCounts([FRESH, WEEK, STALE, NONE], NOW);
    expect(counts).toEqual({ needs: 2, updated: 2, none: 1 });
  });

  it('reports real zeros for a project with no photos at all', () => {
    const counts = siteCounts([unit({ unitNumber: 'A-1' }), unit({ unitNumber: 'A-2' })], NOW);
    expect(counts).toEqual({ needs: 2, updated: 0, none: 2 });
  });

  it('is all zeros for an empty project, not a placeholder', () => {
    expect(siteCounts([], NOW)).toEqual({ needs: 0, updated: 0, none: 0 });
  });
});

describe('defaultSiteFilter', () => {
  it('opens on "Needs a photo" when there is work there', () => {
    expect(defaultSiteFilter({ needs: 3, updated: 10, none: 1 })).toBe('needs');
  });

  it('opens on All when nothing needs a photo', () => {
    expect(defaultSiteFilter({ needs: 0, updated: 10, none: 0 })).toBe('all');
  });
});

describe('isCapped', () => {
  it('flags the server cap so the page can stop claiming a count', () => {
    expect(isCapped(SITE_LIST_CAP - 1)).toBe(false);
    expect(isCapped(SITE_LIST_CAP)).toBe(true);
  });
});

describe('siteUnits', () => {
  const all = [FRESH, WEEK, STALE, NONE];

  it('sorts the most neglected first: stale, then none, then week, then today', () => {
    expect(
      siteUnits(all, { filter: 'all', search: '', now: NOW }).map((u) => u.unitNumber),
    ).toEqual(['B-103', 'B-104', 'B-102', 'B-101']);
  });

  it('breaks ties inside a state by unit number', () => {
    const a = unit({ unitNumber: 'B-110' });
    const b = unit({ unitNumber: 'B-102' });
    expect(
      siteUnits([a, b], { filter: 'all', search: '', now: NOW }).map((u) => u.unitNumber),
    ).toEqual(['B-102', 'B-110']);
  });

  it('puts each filter bucket in the right set', () => {
    const ids = (filter: 'needs' | 'updated' | 'none'): string[] =>
      siteUnits(all, { filter, search: '', now: NOW }).map((u) => u.unitNumber);
    expect(ids('needs')).toEqual(['B-103', 'B-104']);
    expect(ids('updated')).toEqual(['B-102', 'B-101']);
    expect(ids('none')).toEqual(['B-104']);
  });

  it('searches the villa number case-insensitively', () => {
    expect(
      siteUnits(all, { filter: 'all', search: 'b-10', now: NOW }).map((u) => u.unitNumber),
    ).toEqual(['B-103', 'B-104', 'B-102', 'B-101']);
    expect(
      siteUnits(all, { filter: 'all', search: '103', now: NOW }).map((u) => u.unitNumber),
    ).toEqual(['B-103']);
  });

  it('never mutates the input array', () => {
    const input = [FRESH, STALE];
    const copy = [...input];
    siteUnits(input, { filter: 'all', search: '', now: NOW });
    expect(input).toEqual(copy);
  });
});

describe('compareUnitNumbers', () => {
  it('compares numeric parts as numbers, so 2 comes before 10', () => {
    expect(['B-10', 'B-2'].sort(compareUnitNumbers)).toEqual(['B-2', 'B-10']);
  });
});

describe('groupByPhase', () => {
  it('groups by phase and keeps the work-queue order of first appearance', () => {
    const phaseA = { phaseId: 'phase-a', phaseName: 'Phase A' };
    const rows = [
      unit({ unitNumber: 'A-1', ...phaseA, photoCount: 1, lastPhotoAt: ago(40) }),
      unit({ unitNumber: 'B-1', photoCount: 1, lastPhotoAt: ago(0) }),
      unit({ unitNumber: 'A-2', ...phaseA, photoCount: 1, lastPhotoAt: ago(50) }),
    ];
    const sorted = siteUnits(rows, { filter: 'all', search: '', now: NOW });
    const groups = groupByPhase(sorted);
    expect(groups.map((g) => g.phaseName)).toEqual(['Phase A', 'Phase B']);
    // Both A rows are `stale`, so the tie breaks on unit number, and the group
    // keeps that order rather than re-sorting.
    expect(groups[0]?.units.map((u) => u.unitNumber)).toEqual(['A-1', 'A-2']);
  });

  it('is empty for an empty list', () => {
    expect(groupByPhase([])).toEqual([]);
  });
});

describe('phaseAccent', () => {
  it('cycles the four accents by phase index and is stable for a given index', () => {
    expect([0, 1, 2, 3, 4].map(phaseAccent)).toEqual(['sky', 'violet', 'teal', 'amber', 'sky']);
    expect(phaseAccent(0)).toBe(phaseAccent(0));
  });
});

describe('siteRowMeta', () => {
  it('reads "3 BHK · East · 3 days ago"', () => {
    expect(siteRowMeta(unit({ unitNumber: 'x', lastPhotoAt: ago(3), photoCount: 1 }), NOW)).toBe(
      '3 BHK · East · 3 days ago',
    );
  });

  it('says "Facing not set" rather than leaving a blank slot', () => {
    expect(siteRowMeta(unit({ unitNumber: 'x', facing: null }), NOW)).toBe(
      '3 BHK · Facing not set · no photos yet',
    );
  });

  it('names the recorded stage as text, and omits it when unrecorded', () => {
    expect(
      siteRowMeta(
        unit({ unitNumber: 'x', photoCount: 1, lastPhotoAt: ago(3), lastPhotoStage: 'STRUCTURE' }),
        NOW,
      ),
    ).toBe('3 BHK · East · Structure · 3 days ago');
    // A null stage is "not recorded" - it must not render "Not started".
    expect(
      siteRowMeta(
        unit({ unitNumber: 'x', photoCount: 1, lastPhotoAt: ago(3), lastPhotoStage: null }),
        NOW,
      ),
    ).toBe('3 BHK · East · 3 days ago');
  });
});

describe('SITE_EMPTY_COPY', () => {
  it('uses different copy for "no units at all" and "nothing matched"', () => {
    expect(SITE_EMPTY_COPY.noUnits.title).not.toBe(SITE_EMPTY_COPY.filtered.title);
    expect(SITE_EMPTY_COPY.noUnits.body).not.toBe(SITE_EMPTY_COPY.filtered.body);
    expect(SITE_EMPTY_COPY.filtered.title).toBe('Nothing in this filter.');
  });
});

describe('siteEmptyCopyFor / SITE_SCOPE_COPY (2026-11-10)', () => {
  it('gives each scope its own empty copy, with the generic one as the fallback', () => {
    expect(siteEmptyCopyFor('ASSIGNED')).toBe(SITE_EMPTY_COPY.noAssignments);
    expect(siteEmptyCopyFor('MANAGED')).toBe(SITE_EMPTY_COPY.noManaged);
    expect(siteEmptyCopyFor('ALL')).toBe(SITE_EMPTY_COPY.noUnits);
    expect(siteEmptyCopyFor(null)).toBe(SITE_EMPTY_COPY.noUnits);
  });

  it('labels read-only scopes as read-only', () => {
    expect(SITE_SCOPE_COPY.MANAGED).toContain('read-only');
    expect(SITE_SCOPE_COPY.ALL).toContain('read-only');
    expect(SITE_SCOPE_COPY.ASSIGNED).not.toContain('read-only');
  });
});
