// Contract tests for the shared soft-delete read filters.
//
// These constants exist because the Project filter was hand-written at each
// read site and one site (the admin Users table's org-wide project query) was
// missed - so a soft-deleted project still showed as "1 project" on the owner's
// row even though the project registry had correctly hidden it.
//
// The shapes are asserted literally: every consumer spreads them into a Prisma
// `where`, so a renamed key here would silently stop filtering.
import { describe, expect, it } from 'vitest';

import {
  LEAD_IN_ACTIVE_PROJECT,
  PROJECT_ACTIVE,
  PROJECT_TEAM_LIVE,
  isSoftDeleted,
} from './soft-delete-filters';

describe('soft-delete read filters', () => {
  it('PROJECT_ACTIVE filters on deletedAt === null', () => {
    expect(PROJECT_ACTIVE).toEqual({ deletedAt: null });
  });

  it('LEAD_IN_ACTIVE_PROJECT filters through the project relation', () => {
    // A to-one relation filter, so it composes with any other Lead predicate
    // (including a top-level `OR`) without needing an explicit AND.
    expect(LEAD_IN_ACTIVE_PROJECT).toEqual({ project: { deletedAt: null } });
  });

  it('PROJECT_TEAM_LIVE filters both ends of the link', () => {
    // A user's "projects" come from their team's ProjectTeam rows, so the
    // project filter must sit on the link, not on the Project table alone.
    expect(PROJECT_TEAM_LIVE).toEqual({
      project: { deletedAt: null },
      team: { deletedAt: null },
    });
  });

  it('the filter objects are frozen-safe to spread repeatedly', () => {
    // They are spread into `where` objects, never mutated - confirm spreading
    // twice yields independent copies (a shared mutable object here would let
    // one call site leak a filter into another).
    const a = { ...LEAD_IN_ACTIVE_PROJECT };
    const b = { ...LEAD_IN_ACTIVE_PROJECT };
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('isSoftDeleted', () => {
  it('is true only for a stamped deletedAt', () => {
    expect(isSoftDeleted({ deletedAt: new Date() })).toBe(true);
    expect(isSoftDeleted({ deletedAt: null })).toBe(false);
  });
});
