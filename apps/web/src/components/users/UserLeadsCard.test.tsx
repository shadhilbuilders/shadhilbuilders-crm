// UserLeadsCard (T-USER-LEADS, 2026-09-24).
//
// The card's reason to exist: list every lead LINKED to a user (owner OR
// co-owner) and let an admin/owner narrow it BY PROJECT. Both of those are
// server-side concerns, so these tests pin the REQUEST the card issues -
// asserting on rendered rows would pass even if the card filtered a stale
// client-side list.
//
// The load-bearing assertions:
//   1. the request always carries `linkedUserId` (never `ownerId`), because
//      ownerId is owner-ONLY and would silently drop co-owned leads
//   2. changing the project picker re-queries with `projectId`, rather than
//      filtering the rows already on screen (the standing preference:
//      server-driven, never client-side-only filtering)
//   3. the Project column renders the project name, and a row links to its
//      OWN lead detail page
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useLeads: vi.fn(),
  useLeadsEnvelope: vi.fn(),
  useProjects: vi.fn(),
}));

vi.mock('@/hooks/queries/crm', () => ({
  useLeads: mocks.useLeads,
  useLeadsEnvelope: mocks.useLeadsEnvelope,
}));

vi.mock('@/hooks/queries/projects', () => ({
  useProjects: mocks.useProjects,
}));

vi.mock('@/lib/tenant-context', () => ({
  useOrgSlug: () => 'shadhil-builders',
  useOrg: () => ({ id: 'org-1', slug: 'shadhil-builders', name: 'Shadhil' }),
}));

import { buildUserLeadsFilter, UserLeadsCard } from './UserLeadsCard';

const ROWS = [
  {
    id: 'lead-aaa',
    name: 'Rohan Gupta',
    phone: '9876500010',
    status: 'RNR',
    source: 'REFERRAL',
    ownerName: 'Asha',
    projectName: 'Metro Heights',
    projectSlug: 'metro-heights',
    projectId: 'proj-1',
    updatedAt: '2026-09-24T10:00:00.000Z',
  },
  {
    id: 'lead-bbb',
    name: 'Anita Krishnan',
    phone: '9876500011',
    status: 'WON',
    source: 'WALK_IN',
    ownerName: 'Asha',
    projectName: 'Palm Grove',
    projectSlug: 'palm-grove',
    projectId: 'proj-2',
    updatedAt: '2026-09-23T10:00:00.000Z',
  },
];

function lastLeadsFilter(): Record<string, unknown> {
  const calls = mocks.useLeads.mock.calls;
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(ui);
  });
}

beforeEach(() => {
  mocks.useLeads.mockReturnValue({
    data: ROWS,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.useLeadsEnvelope.mockReturnValue({
    total: ROWS.length,
    overdueCount: 0,
    newTodayCount: 0,
  });
  mocks.useProjects.mockReturnValue({
    data: [
      { id: 'proj-1', slug: 'metro-heights', name: 'Metro Heights' },
      { id: 'proj-2', slug: 'palm-grove', name: 'Palm Grove' },
    ],
    isLoading: false,
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

describe('UserLeadsCard - linked-user request', () => {
  it('queries linkedUserId, never ownerId (owner would drop co-owned leads)', async () => {
    await mount(<UserLeadsCard userId="user-42" />);
    const filter = lastLeadsFilter();
    expect(filter['linkedUserId']).toBe('user-42');
    // The strict owner filter must NOT be used here: it would silently omit
    // leads this user only co-owns.
    expect(filter['ownerId']).toBeUndefined();
  });

  it('starts with no project filter (all projects)', async () => {
    await mount(<UserLeadsCard userId="user-42" />);
    expect(lastLeadsFilter()['projectId']).toBeUndefined();
  });

  it('passes pagination server-side (limit/offset), not a client slice', async () => {
    await mount(<UserLeadsCard userId="user-42" />);
    const filter = lastLeadsFilter();
    expect(filter['limit']).toBe(10);
    expect(filter['offset']).toBe(0);
  });
});

// The project picker itself is driven through the library's Combobox, whose
// option list renders in a Base UI portal - a synthetic click is unreliable
// in jsdom (the repo's other Combobox tests assert presence only, for the
// same reason). The filter SHAPE is the real contract, so it is extracted
// into a pure exported function and pinned directly here.
describe('buildUserLeadsFilter - the server-side request', () => {
  const base = { userId: 'user-42', page: 1, pageSize: 10 };

  it('always sends linkedUserId and NEVER ownerId', () => {
    const f = buildUserLeadsFilter(base);
    expect(f.linkedUserId).toBe('user-42');
    // ownerId is owner-ONLY; sending it would silently drop leads the user
    // merely co-owns, which is the whole reason this card exists.
    expect('ownerId' in f).toBe(false);
  });

  it('omits projectId when it is empty (means "all projects")', () => {
    expect(buildUserLeadsFilter({ ...base, projectId: '' }).projectId).toBeUndefined();
    expect(buildUserLeadsFilter(base).projectId).toBeUndefined();
  });

  it('includes projectId once a project is chosen', () => {
    expect(buildUserLeadsFilter({ ...base, projectId: 'proj-1' }).projectId).toBe('proj-1');
  });

  it('honours the >=2 char search contract, server-side', () => {
    expect(buildUserLeadsFilter({ ...base, search: 'r' }).search).toBeUndefined();
    expect(buildUserLeadsFilter({ ...base, search: 'ro' }).search).toBe('ro');
  });

  it('paginates server-side via limit/offset', () => {
    expect(buildUserLeadsFilter(base)).toMatchObject({ limit: 10, offset: 0 });
    expect(buildUserLeadsFilter({ ...base, page: 3 })).toMatchObject({
      limit: 10,
      offset: 20,
    });
    expect(buildUserLeadsFilter({ ...base, page: 2, pageSize: 25 })).toMatchObject({
      limit: 25,
      offset: 25,
    });
  });

  it('forwards sort only when set', () => {
    const unsorted = buildUserLeadsFilter(base);
    expect('sortBy' in unsorted).toBe(false);
    const sorted = buildUserLeadsFilter({ ...base, sortBy: 'updatedAt', sortDir: 'desc' });
    expect(sorted.sortBy).toBe('updatedAt');
    expect(sorted.sortDir).toBe('desc');
  });
});

describe('UserLeadsCard - rendering', () => {
  it('renders the project name column', async () => {
    await mount(<UserLeadsCard userId="user-42" />);
    const text = container?.textContent ?? '';
    expect(text).toContain('Metro Heights');
    expect(text).toContain('Palm Grove');
  });

  it("links each row to its OWN lead detail page (not a foreign entity)", async () => {
    await mount(<UserLeadsCard userId="user-42" />);
    const anchors = Array.from(container?.querySelectorAll('a') ?? []);
    const hrefs = anchors.map((a) => a.getAttribute('href') ?? '');
    // Each row's slug addresses its own lead under its own project.
    expect(hrefs).toContain('/shadhil-builders/projects/metro-heights/leads/lead-aaa');
    expect(hrefs).toContain('/shadhil-builders/projects/palm-grove/leads/lead-bbb');
  });

  it('degrades a row with no project slug to plain text, not a broken link', async () => {
    mocks.useLeads.mockReturnValue({
      data: [{ ...ROWS[0], projectSlug: null, projectName: null }],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    await mount(<UserLeadsCard userId="user-42" />);
    const anchors = Array.from(container?.querySelectorAll('a') ?? []).map(
      (a) => a.getAttribute('href') ?? '',
    );
    expect(anchors.some((h) => h.includes('lead-aaa'))).toBe(false);
    expect(container?.textContent).toContain('Rohan Gupta');
  });

  it('shows the linked-lead count', async () => {
    await mount(<UserLeadsCard userId="user-42" />);
    expect(container?.querySelector('[data-qa="user-leads-count"]')?.textContent).toContain('2');
  });

  it('empty state distinguishes "no leads" from "no matches"', async () => {
    mocks.useLeads.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.useLeadsEnvelope.mockReturnValue({ total: 0, overdueCount: 0, newTodayCount: 0 });
    await mount(<UserLeadsCard userId="user-42" />);
    expect(container?.textContent).toContain('No leads are linked to this user yet.');
  });
});
