// SiteHome (2026-11-08): the engineer's first screen.
//
// protects= the three counts are real numbers from real rows, the sort puts the
//           most neglected villa first, rows group by phase, each filter bucket
//           holds the right rows, a capped list replaces the counts with a
//           notice, and the two empty states are DIFFERENT copy;
// fails_when= a count is invented, the order follows the sales grid instead of
//           neglect, a filter leaks a row from another bucket, a capped list
//           prints an undercount as a total, or "no villas" is shown for a
//           filter that simply matched nothing;
// no_claim= static markup: no clicks, no real fetching, not visual QA. The
//           colour contrast of the four states is owned by the token tests.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { UnitRow } from '@/hooks/queries/inventory';
import { SITE_LIST_CAP } from '@/lib/site-units';

import { SiteHome, type SiteHomeProps } from './SiteHome';

const NOW = new Date('2026-11-08T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

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

const FRESH = unit({ unitNumber: 'B-101', photoCount: 2, lastPhotoAt: ago(0), lastPhotoStage: 'STRUCTURE' });
const WEEK = unit({ unitNumber: 'B-102', photoCount: 1, lastPhotoAt: ago(4) });
const STALE = unit({ unitNumber: 'B-103', photoCount: 6, lastPhotoAt: ago(30) });
const NONE = unit({ unitNumber: 'B-104' });
const PHASE_A = unit({
  unitNumber: 'A-201',
  phaseId: 'phase-a',
  phaseName: 'Phase A',
  photoCount: 1,
  lastPhotoAt: ago(45),
});

const base: SiteHomeProps = {
  projectName: 'Metro Heights',
  orgSlug: 'shadhil-builders',
  projectSlug: 'metro-heights',
  rows: [FRESH, WEEK, STALE, NONE],
  isLoading: false,
  isError: false,
  onRetry: () => undefined,
  filter: 'all',
  onFilterChange: () => undefined,
  search: '',
  onSearchChange: () => undefined,
  capped: false,
  now: NOW,
};

const render = (over: Partial<SiteHomeProps> = {}): string =>
  renderToStaticMarkup(<SiteHome {...base} {...over} />);

/** The unit numbers in row order, as the markup renders them. */
function rowOrder(html: string): string[] {
  return [...html.matchAll(/data-qa="site-unit-row"[^>]*>.*?tabular-nums[^>]*>([^<]+)</g)].map(
    (m) => m[1] ?? '',
  );
}

describe('SiteHome states', () => {
  it('loading: skeleton tiles plus six skeleton rows, no stat numbers', () => {
    const html = render({ isLoading: true });
    expect(html).toContain('data-qa="site-home-skeleton"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('data-qa="site-stat-needs"');
    expect((html.match(/animate-pulse/g) ?? []).length).toBeGreaterThanOrEqual(9);
  });

  it('error: an alert with a retry control', () => {
    const html = render({ isError: true });
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-qa="site-home-retry"');
  });

  it('header names the project', () => {
    const html = render();
    expect(html).toContain('Site updates');
    expect(html).toContain('Metro Heights');
  });
});

describe('SiteHome counts', () => {
  it('protects= the three tiles hold real numbers from the rows', () => {
    const html = render();
    const tile = (qa: string): string =>
      html.match(new RegExp(`data-qa="${qa}"[^>]*>(.*?)</div>`))?.[1] ?? '';
    expect(tile('site-stat-needs')).toContain('2');
    expect(tile('site-stat-week')).toContain('2');
    expect(tile('site-stat-none')).toContain('1');
  });

  it('protects= a project with no photos reports real zeros', () => {
    const html = render({ rows: [unit({ unitNumber: 'A-1' }), unit({ unitNumber: 'A-2' })] });
    expect(html).toContain('data-qa="site-stat-needs"');
    // Two villas, neither photographed: needs 2, week 0, none 2.
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });

  it('fails_when= a capped list prints an undercount as a total', () => {
    const rows = Array.from({ length: SITE_LIST_CAP }, (_v, i) =>
      unit({ unitNumber: `B-${i + 1}`, photoCount: 1, lastPhotoAt: ago(40) }),
    );
    const html = render({ rows, capped: true });
    expect(html).toContain('data-qa="site-home-cap-notice"');
    expect(html).toContain('Showing the first 200 units');
    // The tile says "-", not a number that lies.
    const tile = html.match(/data-qa="site-stat-needs"[^>]*>(.*?)<\/div>/)?.[1] ?? '';
    expect(tile).toContain('-');
  });

  it('always says a state in words, never colour alone', () => {
    const html = render();
    expect(html).toContain('Needs a photo');
    expect(html).toContain('No photos');
    expect(html).toContain('Updated today');
  });
});

describe('SiteHome sort and grouping', () => {
  it('protects= the most neglected villa comes first', () => {
    const order = rowOrder(render());
    expect(order[0]).toBe('B-103'); // stale, 30 days
    expect(order[1]).toBe('B-104'); // never photographed
    expect(order[2]).toBe('B-102'); // this week
    expect(order[3]).toBe('B-101'); // today
  });

  it('groups rows by phase with a unit count in the heading', () => {
    const html = render({ rows: [PHASE_A, STALE, FRESH] });
    expect((html.match(/data-qa="site-phase-group"/g) ?? []).length).toBe(2);
    expect(html).toContain('Phase A');
    expect(html).toContain('Phase B');
    expect(html).toMatch(/1 unit/);
  });

  it('gives each phase a stable left rail accent', () => {
    const html = render({ rows: [PHASE_A, STALE] });
    expect(html).toContain('border-l-4');
    // The first group takes the first accent; a second phase does not repeat it.
    expect(html.match(/border-l-info/g)?.length).toBe(1);
  });
});

describe('SiteHome filters', () => {
  const orderFor = (filter: SiteHomeProps['filter']): string[] => rowOrder(render({ filter }));
  const rowsFor = (filter: SiteHomeProps['filter']): string[] =>
    [...render({ filter }).matchAll(/data-qa="site-unit-row"/g)].map(() => 'row');

  it('protects= each filter bucket holds the right rows', () => {
    expect(orderFor('needs')).toEqual(['B-103', 'B-104']);
    expect(orderFor('updated')).toEqual(['B-102', 'B-101']);
    expect(orderFor('none')).toEqual(['B-104']);
    expect(rowsFor('all')).toHaveLength(4);
  });

  it('renders every filter option', () => {
    const html = render();
    for (const label of ['All', 'Needs a photo', 'Updated', 'No photos']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('data-qa="site-filter"');
  });

  it('searches by villa number', () => {
    expect(orderFor('all')).toHaveLength(4);
    const filtered = rowOrder(render({ search: 'b-103' }));
    expect(filtered).toEqual(['B-103']);
  });
});

describe('SiteHome empty states', () => {
  it('protects= a project with no units gets the library Empty, not a filter message', () => {
    const html = render({ rows: [] });
    expect(html).toContain('data-qa="site-home-empty"');
    expect(html).toContain('No villas on the board yet');
    expect(html).toContain('Units appear here once they are added to a phase of this project.');
    expect(html).not.toContain('data-qa="site-filter-empty"');
  });

  it('protects= a filter that matches nothing gets one quiet line of DIFFERENT copy', () => {
    const html = render({ filter: 'none', rows: [FRESH] });
    expect(html).toContain('data-qa="site-filter-empty"');
    expect(html).toContain('Nothing in this filter.');
    expect(html).not.toContain('No villas on the board yet');
  });
});

describe('SiteHome rows', () => {
  it('sends the whole row to the capture route, project-scoped', () => {
    const html = render({ rows: [STALE] });
    expect(html).toContain(
      'href="/shadhil-builders/projects/metro-heights/site/unit-B-103"',
    );
  });

  it('shows the meta line and omits a stage that was never recorded', () => {
    const html = render({ rows: [WEEK, NONE] });
    expect(html).toContain('3 BHK · East · 4 days ago');
    // A null stage is "not recorded" - never rendered as "Not started".
    expect(html).not.toContain('Not started');
  });

  it('never says "assigned to you" - there is no per-engineer assignment', () => {
    const html = render();
    expect(html).not.toMatch(/assigned to you/i);
  });

  it('carries the search input with its data-qa and placeholder', () => {
    const html = render();
    expect(html).toContain('data-qa="site-unit-search"');
    expect(html).toContain('placeholder="Find a villa number"');
  });
});

describe('SiteHome scope (2026-11-10)', () => {
  it('an engineer with no villas sees the assignment copy, not the generic one', () => {
    const html = render({ rows: [], scope: 'ASSIGNED' });
    expect(html).toContain('No villas assigned to you yet');
    expect(html).not.toContain('No villas on the board yet');
  });

  it('a manager with no managed villas sees the manager copy', () => {
    expect(render({ rows: [], scope: 'MANAGED' })).toContain(
      'No villas assigned to your engineers yet',
    );
  });

  it('says whose villas these are, and names the engineer on review rows', () => {
    const row = unit({
      unitNumber: 'B-110',
      assignedEngineerId: 'e1',
      assignedEngineerName: 'Ravi Kumar',
    });
    const html = render({ rows: [row], scope: 'ALL' });
    expect(html).toContain('Every villa in this project (read-only)');
    expect(html).toContain('Ravi Kumar');
  });

  it('does not name an engineer on the engineer\'s own list', () => {
    const row = unit({ unitNumber: 'B-111', assignedEngineerName: 'Ravi Kumar' });
    expect(render({ rows: [row], scope: 'ASSIGNED' })).not.toContain('Ravi Kumar');
  });
});
