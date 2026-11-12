// canMutateRow - the advisory staff-UI flag (slice 4, 2026-11-07).
//
// protects= canMutate mirrors the RLS mutation predicate: ADMIN/OWNER true,
//           the project photo lead true, the creator true, everyone else false,
//           and the buyer portal (no viewer) gets NO field at all;
// fails_when= the flag disagrees with the policy in either direction - a false
//           hides a control from someone who could use it, a true shows one
//           that will 404;
// no_claim= advice only. progress_photo_update/_delete remain the authority
//           (packages/database/test/progress-rls.test.ts).
import { describe, expect, it } from 'vitest';

import { canMutateRow, toTimelinePhotoDto, type ViewerScope } from './progress-photo.mapper';

const CREATOR = 'user-creator';
const OTHER = 'user-other';

const scope = (over: Partial<ViewerScope> = {}): ViewerScope => ({
  viewer: { userId: OTHER, role: 'ENGINEER' },
  leadsProject: false,
  ...over,
});

describe('canMutateRow', () => {
  it('ADMIN may act on any row', () => {
    expect(
      canMutateRow({ createdBy: CREATOR }, scope({ viewer: { userId: OTHER, role: 'ADMIN' } })),
    ).toBe(true);
  });

  it('OWNER may act (it travels as ADMIN at the GUC layer, but the role reaches here)', () => {
    expect(
      canMutateRow({ createdBy: CREATOR }, scope({ viewer: { userId: OTHER, role: 'OWNER' } })),
    ).toBe(true);
  });

  it('the project photo lead may act on someone else’s photo', () => {
    expect(canMutateRow({ createdBy: CREATOR }, scope({ leadsProject: true }))).toBe(true);
  });

  it('the creator may act on their own photo', () => {
    expect(
      canMutateRow(
        { createdBy: CREATOR },
        scope({ viewer: { userId: CREATOR, role: 'ENGINEER' } }),
      ),
    ).toBe(true);
  });

  it('fails_when= a plain member is told they may act on another member’s photo', () => {
    expect(canMutateRow({ createdBy: CREATOR }, scope())).toBe(false);
  });

  it('fails_when= a photo whose creator was deleted (null) is treated as editable by anyone', () => {
    expect(canMutateRow({ createdBy: null }, scope())).toBe(false);
    // ADMIN still may - the org-wide arm does not depend on the creator.
    expect(
      canMutateRow({ createdBy: null }, scope({ viewer: { userId: OTHER, role: 'ADMIN' } })),
    ).toBe(true);
  });

  it('the buyer portal (no viewer) gets false, never true', () => {
    expect(canMutateRow({ createdBy: CREATOR }, { viewer: null, leadsProject: false })).toBe(false);
  });
});

describe('toTimelinePhotoDto canMutate wire shape', () => {
  const row = {
    id: 'p1',
    unitId: 'u1',
    phaseId: null,
    phase: null,
    mimeType: 'image/jpeg',
    filename: 'a.jpg',
    caption: 'Foundation October 2026',
    takenAt: new Date('2026-10-01T00:00:00Z'),
    stage: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    key: 'org/x/a.jpg',
    createdBy: CREATOR,
  };
  const label = { creator_name: 'Ravi', creator_is_photo_lead: false };

  // The buyer and staff timelines are contractually the SAME DTO (the mapper's
  // header and the parity test both depend on it), so the field is always
  // present - it is false, not absent, for a customer.
  it('always includes the flag, so buyer and staff shapes cannot drift', () => {
    const buyer = toTimelinePhotoDto(row, label, { viewer: null, leadsProject: false });
    expect('canMutate' in buyer).toBe(true);
    expect(buyer.canMutate).toBe(false);
  });

  it('includes the flag on a staff read', () => {
    const dto = toTimelinePhotoDto(
      row,
      label,
      scope({ viewer: { userId: CREATOR, role: 'ENGINEER' } }),
    );
    expect(dto.canMutate).toBe(true);
  });

  it('fails_when= a staff read of another member’s photo claims permission', () => {
    const dto = toTimelinePhotoDto(row, label, scope());
    expect(dto.canMutate).toBe(false);
  });
});
