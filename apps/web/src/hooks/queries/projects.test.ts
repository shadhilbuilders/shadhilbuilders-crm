// @vitest-environment node
// useProjects + pickDefaultProject tests - T-ProjectSwitch (2026-09-05).
// pickDefaultProject is the pure default-selection rule; the hook wiring
// itself is covered by the honest-state pattern shared with useLeads.
import { describe, expect, it } from 'vitest';

import { pickDefaultProject, type ProjectListItem } from './projects';

function project(overrides: Partial<ProjectListItem>): ProjectListItem {
  return {
    id: 'p-1',
    slug: 'some-project',
    name: 'Some Project',
    address: 'Somewhere',
    reraNumber: null,
    cmdaNumber: null,
    createdAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('pickDefaultProject', () => {
  it('prefers the product-locked Metro Heights slug over list order', () => {
    const rows = [
      project({ id: 'fixture-a', slug: 'fixture-project-a' }),
      project({
        id: 'metro',
        slug: 'shadhil-metro-heights',
        name: 'Shadhil Metro Heights',
      }),
    ];
    expect(pickDefaultProject(rows)?.id).toBe('metro');
  });

  it('falls back to the first row when Metro Heights is absent', () => {
    const rows = [
      project({ id: 'first', slug: 'alpha' }),
      project({ id: 'second', slug: 'beta' }),
    ];
    expect(pickDefaultProject(rows)?.id).toBe('first');
  });

  it('returns null for an empty registry', () => {
    expect(pickDefaultProject([])).toBeNull();
  });
});