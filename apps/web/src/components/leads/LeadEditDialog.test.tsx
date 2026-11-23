// LeadEditDialog - form body render tests (autoplan 2026-09-07, plan T5).
//
// The Dialog shell is a Base UI portal (empty under renderToStaticMarkup),
// so per the repo rule the test targets the named export LeadEditFormBody.
// Covers: prefilled fields, data-qa markers, labels visible (no
// placeholder-as-label), save button state.
//
// 2026-11-22: the phone field is `IntlPhoneInput`, which owns the country. The
// value crossing the boundary is the stored canonical DIGITS (never shortened
// the way the old 10-digit-capped input required), and the country trigger
// shows the region the existing number belongs to.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/crm', () => ({
  useUpdateLead: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

import { LeadEditFormBody, toPhoneInputValue } from './LeadEditDialog';

const lead = {
  id: 'lead-1',
  name: 'Priya Sharma',
  phone: '919876543210',
  email: 'priya@example.com',
};

/** The rendered `value` of the input carrying `data-qa`. */
function inputValue(html: string, qa: string): string {
  const input = new RegExp(`<input[^>]*data-qa="${qa}"[^>]*>`).exec(html)?.[0] ?? '';
  return /value="([^"]*)"/.exec(input)?.[1] ?? '';
}

describe('LeadEditFormBody', () => {
  const noopSubmit = () => undefined;

  it('renders prefilled name/phone/email from the lead row', () => {
    const html = renderToStaticMarkup(<LeadEditFormBody lead={lead} onSubmit={noopSubmit} />);
    expect(html).toContain('Priya Sharma');
    // The field is prefilled with the stored canonical digits and shows them
    // the way typing produces them: national, no trunk `0`. libphonenumber's
    // own national format prints `098765 43210`, which is not the number that
    // gets stored, so the field strips it (see IntlPhoneInput.stripTrunkPrefix).
    expect(inputValue(html, 'lead-edit-phone')).toBe('98765 43210');
    expect(html).toContain('priya@example.com');
  });

  it('opens the phone field on the country the number already belongs to', () => {
    const html = renderToStaticMarkup(<LeadEditFormBody lead={lead} onSubmit={noopSubmit} />);
    // The trigger is always visible: a country is never a silent default.
    expect(html).toContain('data-qa="lead-edit-phone-country"');
    expect(html).toContain('+91');
  });

  it('renders visible labels (no placeholder-as-label) + data-qa markers', () => {
    const html = renderToStaticMarkup(<LeadEditFormBody lead={lead} onSubmit={noopSubmit} />);
    expect(html).toContain('Full name');
    expect(html).toContain('Phone');
    expect(html).toContain('Email');
    expect(html).toContain('data-qa="lead-edit-name"');
    expect(html).toContain('data-qa="lead-edit-phone"');
    expect(html).toContain('data-qa="lead-edit-email"');
  });

  it('has no notes field (D15: Lead has no notes column - contract drops it)', () => {
    const html = renderToStaticMarkup(<LeadEditFormBody lead={lead} onSubmit={noopSubmit} />);
    expect(html).not.toContain('Notes');
  });

  it('hides the Form action section - Save lives in the Dialog footer', () => {
    // The Save/Cancel actions belong to the Dialog footer (type=submit +
    // form=lead-edit-form), not the Form body. Assert the body renders NO
    // inline submit/reset buttons so the submit isn't duplicated.
    const html = renderToStaticMarkup(<LeadEditFormBody lead={lead} onSubmit={noopSubmit} />);
    expect(html).not.toContain('data-qa="form-submit-button"');
    expect(html).not.toContain('data-qa="form-reset-button"');
    expect(html).not.toContain('Save changes');
  });

  it('no longer claims the country code is added automatically', () => {
    const html = renderToStaticMarkup(<LeadEditFormBody lead={lead} onSubmit={noopSubmit} />);
    expect(html).not.toContain('10-digit');
    expect(html).not.toContain('added automatically');
  });
});

/**
 * Prefill contract (2026-11-22).
 *
 * The stored value crossing into the field is canonical digits. `IntlPhoneInput`
 * carries the country itself, so nothing is shortened any more; the legacy bare
 * mobile is lifted to canonical form because a bare national number has no
 * country for the server to parse it in.
 */
describe('toPhoneInputValue', () => {
  it('returns canonical digits unchanged', () => {
    expect(toPhoneInputValue('919876543210')).toBe('919876543210');
  });

  it('lifts a legacy bare 10-digit mobile to canonical digits', () => {
    expect(toPhoneInputValue('9876543210')).toBe('919876543210');
  });

  it('drops the + from an explicit E.164 value', () => {
    expect(toPhoneInputValue('+919876543210')).toBe('919876543210');
  });

  it('does not touch a foreign number (would corrupt it)', () => {
    expect(toPhoneInputValue('14155550123')).toBe('14155550123');
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(toPhoneInputValue(null)).toBe('');
    expect(toPhoneInputValue(undefined)).toBe('');
    expect(toPhoneInputValue('')).toBe('');
  });
});
