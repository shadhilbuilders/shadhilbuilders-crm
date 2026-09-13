import { describe, expect, it } from 'vitest';

import {
  computePreviewToken,
  planOwnershipTransfer,
  type LeadOwnershipSnapshot,
} from './team-removal.util';

describe('computePreviewToken', () => {
  it('is deterministic regardless of input row order', () => {
    const a: LeadOwnershipSnapshot = {
      id: 'lead-1',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ownerId: 'user-a',
      coOwnerId: null,
    };
    const b: LeadOwnershipSnapshot = {
      id: 'lead-2',
      updatedAt: '2026-01-02T00:00:00.000Z',
      ownerId: 'user-b',
      coOwnerId: 'user-c',
    };
    expect(computePreviewToken([a, b])).toBe(computePreviewToken([b, a]));
  });

  it('accepts Date or ISO-string updatedAt identically', () => {
    const withDate: LeadOwnershipSnapshot = {
      id: 'lead-1',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ownerId: 'user-a',
      coOwnerId: null,
    };
    const withString: LeadOwnershipSnapshot = {
      id: 'lead-1',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ownerId: 'user-a',
      coOwnerId: null,
    };
    expect(computePreviewToken([withDate])).toBe(computePreviewToken([withString]));
  });

  it('changes when any lead updatedAt/owner/coOwner changes', () => {
    const base: LeadOwnershipSnapshot = {
      id: 'lead-1',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ownerId: 'user-a',
      coOwnerId: null,
    };
    const t0 = computePreviewToken([base]);
    expect(computePreviewToken([{ ...base, updatedAt: '2026-01-01T00:00:01.000Z' }])).not.toBe(t0);
    expect(computePreviewToken([{ ...base, ownerId: 'user-b' }])).not.toBe(t0);
    expect(computePreviewToken([{ ...base, coOwnerId: 'user-c' }])).not.toBe(t0);
  });

  it('the empty set has a stable, non-empty token', () => {
    const token = computePreviewToken([]);
    expect(token).toHaveLength(64); // sha256 hex digest
    expect(computePreviewToken([])).toBe(token);
  });

  it('null vs empty-string coOwnerId never collide (fence character)', () => {
    const nullCoOwner: LeadOwnershipSnapshot = {
      id: 'lead-1',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ownerId: 'user-a',
      coOwnerId: null,
    };
    // A real coOwnerId can never BE the empty string (cuid2), but this
    // pins the encoding choice so a future refactor can't silently
    // introduce a null/"" collision.
    const emptyStringCoOwner: LeadOwnershipSnapshot = { ...nullCoOwner, coOwnerId: '' as string };
    expect(computePreviewToken([nullCoOwner])).toBe(computePreviewToken([emptyStringCoOwner]));
  });
});

describe('planOwnershipTransfer', () => {
  const D = 'departing-user';
  const R = 'replacement-user';
  const OTHER = 'someone-else';

  it('owner leads where replacement is NOT already co-owner -> reassignOwnerLeadIds', () => {
    const leads: LeadOwnershipSnapshot[] = [
      { id: 'l1', updatedAt: '2026-01-01', ownerId: D, coOwnerId: null },
      { id: 'l2', updatedAt: '2026-01-01', ownerId: D, coOwnerId: OTHER },
    ];
    const plan = planOwnershipTransfer(leads, D, R);
    expect(plan.reassignOwnerLeadIds.sort()).toEqual(['l1', 'l2']);
    expect(plan.promoteCoOwnerToOwnerLeadIds).toEqual([]);
    expect(plan.clearCoOwnerLeadIds).toEqual([]);
    expect(plan.reassignCoOwnerLeadIds).toEqual([]);
  });

  it('owner leads where replacement IS already co-owner -> promoteCoOwnerToOwnerLeadIds', () => {
    const leads: LeadOwnershipSnapshot[] = [
      { id: 'l1', updatedAt: '2026-01-01', ownerId: D, coOwnerId: R },
    ];
    const plan = planOwnershipTransfer(leads, D, R);
    expect(plan.promoteCoOwnerToOwnerLeadIds).toEqual(['l1']);
    expect(plan.reassignOwnerLeadIds).toEqual([]);
  });

  it('co-owner leads where replacement is NOT already owner -> reassignCoOwnerLeadIds', () => {
    const leads: LeadOwnershipSnapshot[] = [
      { id: 'l1', updatedAt: '2026-01-01', ownerId: OTHER, coOwnerId: D },
    ];
    const plan = planOwnershipTransfer(leads, D, R);
    expect(plan.reassignCoOwnerLeadIds).toEqual(['l1']);
    expect(plan.clearCoOwnerLeadIds).toEqual([]);
  });

  it('co-owner leads where replacement IS already owner -> clearCoOwnerLeadIds', () => {
    const leads: LeadOwnershipSnapshot[] = [
      { id: 'l1', updatedAt: '2026-01-01', ownerId: R, coOwnerId: D },
    ];
    const plan = planOwnershipTransfer(leads, D, R);
    expect(plan.clearCoOwnerLeadIds).toEqual(['l1']);
    expect(plan.reassignCoOwnerLeadIds).toEqual([]);
  });

  it('every affected lead lands in exactly one category (mutually exclusive partition)', () => {
    const leads: LeadOwnershipSnapshot[] = [
      { id: 'l1', updatedAt: '2026-01-01', ownerId: D, coOwnerId: null },
      { id: 'l2', updatedAt: '2026-01-01', ownerId: D, coOwnerId: R },
      { id: 'l3', updatedAt: '2026-01-01', ownerId: OTHER, coOwnerId: D },
      { id: 'l4', updatedAt: '2026-01-01', ownerId: R, coOwnerId: D },
      // unaffected lead - departing user is neither owner nor coOwner.
      { id: 'l5', updatedAt: '2026-01-01', ownerId: OTHER, coOwnerId: R },
    ];
    const plan = planOwnershipTransfer(leads, D, R);
    const allPlanned = [
      ...plan.promoteCoOwnerToOwnerLeadIds,
      ...plan.reassignOwnerLeadIds,
      ...plan.clearCoOwnerLeadIds,
      ...plan.reassignCoOwnerLeadIds,
    ].sort();
    expect(allPlanned).toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  it('an empty lead list produces an empty plan', () => {
    const plan = planOwnershipTransfer([], D, R);
    expect(plan).toEqual({
      promoteCoOwnerToOwnerLeadIds: [],
      reassignOwnerLeadIds: [],
      clearCoOwnerLeadIds: [],
      reassignCoOwnerLeadIds: [],
    });
  });
});
