// T-WA-VISIT-REPLY (2026-11-11): what a customer's WhatsApp reply means.
//
// The reminder copy says "Reply YES to confirm or RESCHEDULE", so exactly those
// words have to do something. Everything else is an ordinary message from a
// customer and must stay one: the parser answers null rather than guessing,
// because a visit confirmed by mistake tells a sales exec to drive out to a
// site nobody is waiting at.
import { describe, expect, it } from 'vitest';

import { parseVisitReply } from './visit-reply';

describe('parseVisitReply', () => {
  it.each([
    ['YES', 'CONFIRM'],
    ['yes', 'CONFIRM'],
    ['Yes', 'CONFIRM'],
    ['  YES  ', 'CONFIRM'],
    ['YES!!', 'CONFIRM'],
    ['YES!!!', 'CONFIRM'],
    ['YES 👍', 'CONFIRM'],
    ['Y', 'CONFIRM'],
    ['y.', 'CONFIRM'],
    ['CONFIRM', 'CONFIRM'],
    ['confirm', 'CONFIRM'],
    ['RESCHEDULE', 'RESCHEDULE'],
    ['reschedule', 'RESCHEDULE'],
    ['RESCHED', 'RESCHEDULE'],
    ['Reschedule.', 'RESCHEDULE'],
    ['RESCHEDULE 👍', 'RESCHEDULE'],
  ])('reads %j as %s', (body, expected) => {
    expect(parseVisitReply(body)).toBe(expected);
  });

  it.each([
    // Whole-message only. A sentence that happens to start with yes is a
    // customer talking, not a checkbox - and a stray "no" inside a sentence
    // must never cancel a visit.
    ['yes I will come by 5'],
    ['Yes, but can we make it after 6?'],
    ['yes please reschedule to Sunday'],
    ['no'],
    ['no thanks'],
    ['confirmed'],
    ['Y E S'],
    ['rescheduled'],
    ['ok'],
    [''],
    ['   '],
  ])('leaves %j alone', (body) => {
    expect(parseVisitReply(body)).toBeNull();
  });
});
