// The site-update template's URL button (build-sequence step 8).
//
// protects= a button component is sent ONLY to the two templates that were
// approved with one, and its variable is the saved row id the portal opens.
// fails_when= a body-only template (chat reply, visit follow-up, reminder,
// welcome) is sent a button component - Meta rejects that with 132000 - or the
// button carries an empty id, which builds a dead portal link.
import { describe, expect, it } from 'vitest';

import {
  bodyVars,
  buttonValue,
  hasUrlButton,
  SITE_UPDATE_TEMPLATE_IMAGE,
  SITE_UPDATE_TEMPLATE_VIDEO,
} from './outbound.service';

describe('site-update URL button', () => {
  it('is present only on the two site-update templates', () => {
    expect(hasUrlButton(SITE_UPDATE_TEMPLATE_VIDEO)).toBe(true);
    expect(hasUrlButton(SITE_UPDATE_TEMPLATE_IMAGE)).toBe(true);
    for (const other of [
      'shadhil_chat_reply',
      'shadhil_visit_followup',
      'shadhil_visit_reminder',
      'shadhil_welcome_enquiry',
    ]) {
      expect(hasUrlButton(other)).toBe(false);
    }
  });

  it('carries the row id the portal opens', () => {
    expect(buttonValue(SITE_UPDATE_TEMPLATE_VIDEO, { '1': 'A-101', photo: 'row-9' })).toBe('row-9');
    expect(buttonValue(SITE_UPDATE_TEMPLATE_IMAGE, { '1': 'A-101', photo: 'row-9' })).toBe('row-9');
  });

  it('falls back to the body value, so an older row cannot build a dead link', () => {
    expect(buttonValue(SITE_UPDATE_TEMPLATE_VIDEO, { '1': 'A-101' })).toBe('A-101');
  });

  it('is empty for every template that has no button', () => {
    expect(buttonValue('shadhil_chat_reply', { '1': 'x', photo: 'row-9' })).toBe('');
  });
});

describe('bodyVars', () => {
  it('sends numbered slots only, never the button variable', () => {
    // The exact bug this guards: the row carries {1,2,3,photo}, and a body with
    // four parameters against a three-variable template is a Meta 132000.
    expect(bodyVars({ '1': 'Asha', '2': 'A-101', '3': 'Plinth poured', photo: 'row-9' })).toEqual({
      '1': 'Asha',
      '2': 'A-101',
      '3': 'Plinth poured',
    });
  });

  it('leaves older body-only templates untouched', () => {
    expect(bodyVars({ '1': 'Lead', '2': 'Tomorrow' })).toEqual({ '1': 'Lead', '2': 'Tomorrow' });
  });
});
