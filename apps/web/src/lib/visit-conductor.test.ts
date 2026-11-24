// coOwnerClash - the create-time 409, predicted before the form is filled in.
//
// protects= naming a different conductor on a co-owned lead is reported BEFORE the
//           submit, and naming the current holder (or the owner) stays silent;
// fails_when= the rule starts flagging the person who already holds the seat, drops
//           the owner exemption, or ignores the blank-field-means-me case;
// no_claim= the manager-who-leads-the-lead's-team exemption, which the server
//           allows and this helper cannot see. It is why callers warn instead of
//           blocking.
import { describe, expect, it } from 'vitest';

import { canConductVisit, coOwnerClash, VISIT_CONDUCTOR_ROLES } from './visit-conductor';

describe('coOwnerClash', () => {
  const lead = { ownerId: 'owner-1', coOwnerId: 'exec-a', coOwnerName: 'Priya' };

  it('flags a different person on a co-owned lead', () => {
    expect(coOwnerClash(lead, 'exec-b')).toEqual({ coOwnerId: 'exec-a', coOwnerName: 'Priya' });
  });

  it('stays silent when the conductor already holds the seat', () => {
    expect(coOwnerClash(lead, 'exec-a')).toBeNull();
  });

  it('stays silent for the lead owner, who reads it without the seat', () => {
    expect(coOwnerClash(lead, 'owner-1')).toBeNull();
  });

  it('stays silent on a lead with no co-owner', () => {
    expect(coOwnerClash({ ownerId: 'owner-1', coOwnerId: null }, 'exec-b')).toBeNull();
    expect(coOwnerClash({}, 'exec-b')).toBeNull();
  });

  it('stays silent when nobody was named and the actor cannot conduct', () => {
    // A blank field only resolves to a person for a role that may conduct; a
    // telecaller's blank field is a 400 for a different reason.
    expect(coOwnerClash(lead, '')).toBeNull();
    expect(coOwnerClash(lead, undefined)).toBeNull();
  });
});

describe('canConductVisit', () => {
  it('accepts exactly the four roles the server accepts', () => {
    for (const role of VISIT_CONDUCTOR_ROLES) expect(canConductVisit(role)).toBe(true);
    for (const role of ['TELECALLER', 'ENGINEER', 'CUSTOMER', '', null, undefined]) {
      expect(canConductVisit(role)).toBe(false);
    }
  });
});
