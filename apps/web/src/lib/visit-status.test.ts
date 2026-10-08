// Visit status → colour mapping (2026-09-29, owner request).
//
// Pins the exact split the owner asked for - green if the visit happened, red if
// it did not, yellow if rescheduled - plus the two statuses they did not name,
// which are the ones most likely to be "fixed" wrongly later:
//
//   SCHEDULED   must stay OFF red. A future visit has not failed; painting every
//               upcoming visit red would read as a broken calendar.
//   CANCELLED   belongs on the red side - it is a closed row where nothing
//               happened on site, same as NO_SHOW.
//
// Also pins that the mapping is EXHAUSTIVE over the five VisitStatus values, so
// a new enum member cannot quietly render as the neutral fallback.
import { describe, expect, it } from 'vitest';

import { isUpcomingVisit, isUpcomingVisitForLead, isVisitClosed, todaysOpenVisits, toVisitEventMeta, visitStatusColor } from './visit-status';
import type { VisitApiRow } from './visit-status';

// The five values of VisitStatus (packages/api-types/src/enums.ts). Duplicated
// deliberately: the test asserts the mapper covers the real enum, so if the enum
// grows, this list is the reminder to extend the mapper.
const ALL_VISIT_STATUSES = ['SCHEDULED', 'RESCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'];

describe('visitStatusColor', () => {
  it('maps the owner\u2019s three rulings exactly', () => {
    expect(visitStatusColor('COMPLETED')).toBe('green'); // visit happened
    expect(visitStatusColor('NO_SHOW')).toBe('red'); // did not happen
    expect(visitStatusColor('RESCHEDULED')).toBe('yellow'); // rescheduled
  });

  it('keeps a future SCHEDULED visit off red', () => {
    // The un-named status that must NOT be treated as a failure: every upcoming
    // visit is SCHEDULED, and red here would make the whole calendar look broken.
    expect(visitStatusColor('SCHEDULED')).toBe('blue');
    expect(visitStatusColor('SCHEDULED')).not.toBe('red');
  });

  it('treats CANCELLED as a did-not-happen (red) row', () => {
    expect(visitStatusColor('CANCELLED')).toBe('red');
  });

  it('covers every VisitStatus value, so no enum member falls through', () => {
    for (const status of ALL_VISIT_STATUSES) {
      expect(visitStatusColor(status), `${status} has no colour`).not.toBe('gray');
    }
  });

  it('gives an unknown status the neutral fallback, not a confident colour', () => {
    // A newer backend enum this build has not shipped for yet. Neutral is the
    // honest answer; green/red would be a claim the app cannot support.
    expect(visitStatusColor('SOMETHING_NEW')).toBe('gray');
    expect(visitStatusColor('')).toBe('gray');
    expect(visitStatusColor(null)).toBe('gray');
    expect(visitStatusColor(undefined)).toBe('gray');
  });

  it('prefers a recorded outcome over a stale SCHEDULED status', () => {
    // The service sets status = outcome when an outcome is recorded, but an
    // older row can carry an outcome while still reading SCHEDULED. The outcome
    // is the true story, so it wins.
    expect(visitStatusColor('SCHEDULED', 'COMPLETED')).toBe('green');
    expect(visitStatusColor('SCHEDULED', 'NO_SHOW')).toBe('red');
    // An empty-string outcome is "no outcome", so status decides.
    expect(visitStatusColor('COMPLETED', '')).toBe('green');
    expect(visitStatusColor('COMPLETED', null)).toBe('green');
  });
});

describe('isVisitClosed', () => {
  it('is true only for the terminal outcomes', () => {
    expect(isVisitClosed('COMPLETED')).toBe(true);
    expect(isVisitClosed('NO_SHOW')).toBe(true);
    expect(isVisitClosed('CANCELLED')).toBe(true);
  });

  it('is false for a visit that can still be conducted or moved', () => {
    expect(isVisitClosed('SCHEDULED')).toBe(false);
    // RESCHEDULED is NOT closed by this definition: the row is superseded rather
    // than finished on site, and the service still accepts an outcome for it.
    expect(isVisitClosed('RESCHEDULED')).toBe(false);
    expect(isVisitClosed(null)).toBe(false);
    expect(isVisitClosed(undefined)).toBe(false);
  });
});

describe('toVisitEventMeta', () => {
  const row: VisitApiRow = {
    id: 'visit-1',
    leadId: 'lead-1',
    leadName: 'Asha',
    leadState: 'VISITED',
    scheduledFor: '2026-09-29T10:00:00.000Z',
    userId: 'user-1',
    userName: 'Ravi',
    status: 'COMPLETED',
    outcome: 'COMPLETED',
    notes: 'nice',
    updatedAt: '2026-09-29T11:00:00.000Z',
  };

  it('carries the fields the dialog needs and the calendar used to drop', () => {
    // Regression guard for the actual bug: the event mapper threw away leadId,
    // status and outcome, so the detail dialog had nothing to show and no way to
    // link to the lead.
    expect(toVisitEventMeta(row)).toEqual({
      status: 'COMPLETED',
      outcome: 'COMPLETED',
      leadId: 'lead-1',
      leadState: 'VISITED',
    });
  });

  it('carries the LEAD state, so both pages can show the same status word', () => {
    // Owner requirement 2026-09-29: the visits page and the lead page must not
    // disagree. The lead page renders the lead's pipeline state, so the visit
    // event has to carry it - otherwise the dialog has to infer a status from the
    // visit alone and says "Done" where the lead page says "Visited".
    expect(toVisitEventMeta(row).leadState).toBe('VISITED');
  });
});

describe('isUpcomingVisit', () => {
  it('keeps open visits in the default (upcoming) view', () => {
    expect(isUpcomingVisit('SCHEDULED')).toBe(true);
  });

  it('does not treat a RESCHEDULED row (a replaced appointment) as upcoming', () => {
    expect(isUpcomingVisit('RESCHEDULED')).toBe(false);
  });

  it('treats every closed status as history', () => {
    expect(isUpcomingVisit('COMPLETED')).toBe(false);
    expect(isUpcomingVisit('NO_SHOW')).toBe(false);
    expect(isUpcomingVisit('CANCELLED')).toBe(false);
    expect(isUpcomingVisit(null)).toBe(false);
    expect(isUpcomingVisit(undefined)).toBe(false);
    expect(isUpcomingVisit('')).toBe(false);
  });

  it('decides on STATUS, not the clock', () => {
    // A SCHEDULED visit whose slot has passed is still open work - nobody
    // recorded an outcome. Hiding it would make un-actioned work vanish from the
    // one page built to show it, so this predicate deliberately takes no date.
    // (The signature is the assertion: one argument, a status.)
    expect(isUpcomingVisit.length).toBe(1);
    expect(isUpcomingVisit('SCHEDULED')).toBe(true);
  });
});

describe('isUpcomingVisitForLead', () => {
  // OWNER DIRECTION (2026-09-30): a terminal-lead visit leaves the default view.
  // The production case: lead cmu55o070000wyju83nmyivva is WON with an open visit
  // whose slot had passed 11 days earlier, and it still listed as upcoming
  // because nothing closes a visit on a terminal lead (deliberately - a won deal
  // may still owe a handover) and the page only ever asked the VISIT's status.
  const at = (status: string, leadState: string) => ({ status, leadState });

  it('keeps live work on a live deal', () => {
    expect(isUpcomingVisitForLead(at('SCHEDULED', 'VISIT_SCHEDULED'))).toBe(true);
    expect(isUpcomingVisitForLead(at('SCHEDULED', 'CONTACTED'))).toBe(true);
    expect(isUpcomingVisitForLead(at('RESCHEDULED', 'NEGOTIATION'))).toBe(false);
  });

  it('hides an open visit whose lead has settled', () => {
    // The bug. Each of these is an OPEN visit that is not upcoming work.
    expect(isUpcomingVisitForLead(at('SCHEDULED', 'WON'))).toBe(false);
    expect(isUpcomingVisitForLead(at('SCHEDULED', 'LOST'))).toBe(false);
    expect(isUpcomingVisitForLead(at('SCHEDULED', 'RNR'))).toBe(false);
    expect(isUpcomingVisitForLead(at('RESCHEDULED', 'WON'))).toBe(false);
  });

  it('still hides closed visits, whatever the lead is doing', () => {
    // The lead-state check is an ADDITION, not a replacement: a closed visit was
    // already history and must stay that way.
    expect(isUpcomingVisitForLead(at('COMPLETED', 'NEGOTIATION'))).toBe(false);
    expect(isUpcomingVisitForLead(at('NO_SHOW', 'VISIT_SCHEDULED'))).toBe(false);
    expect(isUpcomingVisitForLead(at('CANCELLED', 'VISIT_SCHEDULED'))).toBe(false);
  });

  it('fails OPEN when the lead state is missing or unknown', () => {
    // A row wrongly hidden is invisible and unreportable; a row wrongly shown is
    // one the operator can see and cancel. So an unknown state keeps it visible,
    // rather than silently swallowing work if the backend adds a state.
    expect(isUpcomingVisitForLead(at('SCHEDULED', ''))).toBe(true);
    expect(isUpcomingVisitForLead(at('SCHEDULED', 'SOME_FUTURE_STATE'))).toBe(true);
  });

  it('uses TERMINAL states, not just dead ones', () => {
    // The distinction that makes this predicate the right one: WON is terminal
    // but NOT dead (isDeadLeadState is LOST/RNR only). A won deal's visit is not
    // dead work - it is simply not UPCOMING work, so it leaves this view while
    // staying valid everywhere else (e.g. the lead page's own visit panel).
    expect(isUpcomingVisitForLead(at('SCHEDULED', 'WON'))).toBe(false);
  });
});

describe('todaysOpenVisits', () => {
  const v = (id: string, leadId: string, status: string, leadState: string, scheduledFor: string) => ({
    id,
    leadId,
    status,
    leadState,
    scheduledFor,
  });

  it('drops a WON lead (the cmuzrrv5m000v41u8740254ur regression)', () => {
    const rows = [v('a', 'L1', 'SCHEDULED', 'WON', '2026-10-09T10:00:00Z')];
    expect(todaysOpenVisits(rows)).toEqual([]);
  });

  it('shows one row per lead, keeping the earliest slot', () => {
    const rows = [
      v('late', 'L1', 'SCHEDULED', 'VISIT_SCHEDULED', '2026-10-09T15:00:00Z'),
      v('early', 'L1', 'SCHEDULED', 'VISIT_SCHEDULED', '2026-10-09T09:00:00Z'),
      v('other', 'L2', 'SCHEDULED', 'VISIT_SCHEDULED', '2026-10-09T11:00:00Z'),
    ];
    expect(todaysOpenVisits(rows).map((r) => r.id)).toEqual(['early', 'other']);
  });

  it('drops closed and replaced visits', () => {
    const rows = [
      v('c', 'L1', 'COMPLETED', 'VISITED', '2026-10-09T09:00:00Z'),
      v('r', 'L2', 'RESCHEDULED', 'RESCHEDULED', '2026-10-09T09:00:00Z'),
    ];
    expect(todaysOpenVisits(rows)).toEqual([]);
  });
});
