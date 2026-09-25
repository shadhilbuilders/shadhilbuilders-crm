// Inventory grid - "Search by villa" wiring (T-INV-SEARCH, 2026-09-25).
//
// Pins a LIBRARY TRAP in the page source, because the failure is silent.
// `@paalstack/react-ui`'s DataTable decides how to apply the search box from
// the SHAPE of `search.accessorKey`:
//
//   accessorKey: ['unitNumber']              -> table.getColumn('unitNumber')
//                                               .setFilterValue(...)
//                                               A TanStack COLUMN filter, which
//                                               `globalFilterFn` does NOT
//                                               govern - so the grid trims the
//                                               rows client-side on top of the
//                                               server-filtered page.
//   accessorKey: ['unitNumber','unitNumber'] -> table.setGlobalFilter({...}),
//                                               which `globalFilterFn={() => true}`
//                                               then neutralises.
//
// Observed live with the single-key form: searching "A" rendered 3 rows while
// the pagination total (a SERVER value) still read "of 16" - the page
// contradicting itself, with no error anywhere. admin/users and UserLeadsCard
// avoid this only because they happen to pass two accessor keys; the single-key
// case is the broken one, and nothing else in the suite would catch a revert.
//
// Asserted against the page SOURCE (not by mounting): the decision lives in the
// library's bundled toolbar, so mounting would test a mock of it.

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const PAGE = 'src/app/[orgSlug]/projects/[projectSlug]/inventory/page.tsx';
const raw = fs.readFileSync(PAGE, 'utf8');

/**
 * Strip // comments so a match cannot be satisfied by PROSE that merely
 * mentions the code. Without this the globalFilterFn assertion below passed
 * even after the real prop was deleted, because a nearby comment quoted it -
 * a test that proves nothing while looking green.
 */
function stripLineComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
}

const src = stripLineComments(raw);

describe('inventory search - DataTable wiring in the page source', () => {
  it('the comment stripper does not eat real code (guard for the guard)', () => {
    const sample = "a//comment\nconst x = 1; // trailing";
    const out = stripLineComments(sample);
    expect(out).toContain('const x = 1;');
    expect(out).not.toContain('comment');
  });

  it('passes TWO accessor keys so the global-filter branch is taken', () => {
    expect(src).toMatch(/accessorKey:\s*\['unitNumber',\s*'unitNumber'\]/);
  });

  it('keeps the no-op globalFilterFn that neutralises client-side filtering', () => {
    // Without this, the global-filter branch would filter the page client-side
    // and hide rows the server legitimately returned.
    expect(src).toMatch(/globalFilterFn=\{\(\) => true\}/);
  });

  it('searches the villa number only - no second REAL column in the client filter', () => {
    // `phaseName`/`projectName`/`facing` ARE on the row, so listing one to
    // satisfy the two-key rule would widen the client filter beyond what the
    // server searched and produce a confusing empty grid.
    expect(src).not.toMatch(/accessorKey:\s*\[[^\]]*(phaseName|projectName|facing)/);
  });

  it('wires the search box to the server via the query param (not a local state filter)', () => {
    expect(src).toMatch(/serverSearch/);
    expect(src).toMatch(/search:\s*serverSearch/);
  });

  it('guards the search with a >=2 char minimum, matching the leads/users grids', () => {
    expect(src).toMatch(/debouncedSearch\.trim\(\)\.length >= 2/);
    expect(src).toMatch(/useDebouncedValue\(search, 300\)/);
  });

  it('isFiltered includes EVERY toolbar filter (or the empty state lies)', () => {
    // The empty state branches on isFiltered: if a filter is omitted from it,
    // filtering to zero rows shows "No inventory yet." - telling the user the
    // project is empty when they merely filtered everything out.
    // Caught by sabotage: dropping ANY single clause from isFiltered left all
    // the other assertions green, so only naming all five closes the gap.
    const block = src.slice(src.indexOf('const isFiltered'));
    const expr = block.slice(0, block.indexOf(';'));
    for (const f of ['statusFilter', 'phaseFilter', 'bhkFilter', 'facingFilter', 'serverSearch']) {
      expect(expr).toContain(f);
    }
  });

  it('reports a search miss as a search miss (not a filter miss)', () => {
    // "No units match these filters / try clearing a filter" would be a lie for
    // a villa number the user typed.
    expect(src).toMatch(/No villa matches/);
  });
});
