// LeadEditDialog - form body render tests (autoplan 2026-09-07, plan T5).
//
// The Dialog shell is a Base UI portal (empty under renderToStaticMarkup),
// so per the repo rule the test targets the named export LeadEditFormBody.
// Covers: prefilled fields, data-qa markers, labels visible (no
// placeholder-as-label), save button state.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/crm', () => ({
  useUpdateLead: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

import { LeadEditFormBody, toPhoneInputValue } from './LeadEditDialog';

const lead = {
  id: 'lead-1',
  name: 'Priya Sharma',
  phone: '9876543210',
  email: 'priya@example.com',
};

describe('LeadEditFormBody', () => {
  const noopSubmit = () => undefined;

  it('renders prefilled name/phone/email from the lead row', () => {
    const html = renderToStaticMarkup(<LeadEditFormBody lead={lead} onSubmit={noopSubmit} />);
    expect(html).toContain('Priya Sharma');
    expect(html).toContain('9876543210');
    expect(html).toContain('priya@example.com');
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
});

/**
 * Defect 1 regression (fixed 2026-11-18).
 *
 * The stored value is the digits-only normalized form (`919876543210`), but
 * PhoneNumberInput caps typing at 10 digits and sanitizes on every change.
 * Feeding the 12-digit stored value straight into the form rendered fine and
 * then truncated on the FIRST KEYSTROKE, so editing a lead's name silently
 * rewrote its phone number:
 *
 *   919876543210 --one keystroke--> 9198765432 --normalized--> 919198765432
 *
 * These tests pin the prefill conversion that removes the mismatch.
 */
describe('toPhoneInputValue (Defect 1)', () => {
  it('shortens the stored 12-digit form to the 10-digit local mobile', () => {
    expect(toPhoneInputValue('919876543210')).toBe('9876543210');
  });

  it('leaves a plain 10-digit value alone', () => {
    expect(toPhoneInputValue('9876543210')).toBe('9876543210');
  });

  it('leaves an explicit +91 value alone in digit form', () => {
    // The + is stripped for the input, but the local part is what is shown.
    expect(toPhoneInputValue('+919876543210')).toBe('9876543210');
  });

  it('does not shorten a foreign number (would corrupt it)', () => {
    expect(toPhoneInputValue('14155550123')).toBe('14155550123');
  });

  it('passes masked placeholders through untouched', () => {
    expect(toPhoneInputValue('+919****3210')).toBe('+919****3210');
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(toPhoneInputValue(null)).toBe('');
    expect(toPhoneInputValue(undefined)).toBe('');
    expect(toPhoneInputValue('')).toBe('');
  });

  it('round-trips: prefilled value, one keystroke appended, still the same person', () => {
    // Simulate the real path: stored -> prefill -> user appends a digit ->
    // PhoneNumberInput sanitizes -> server normalizes.
    const stored = '919876543210';
    const prefilled = toPhoneInputValue(stored);
    const afterKeystroke = (prefilled + '9').replace(/\D/g, '').slice(0, 10);
    // Appending to a 10-digit field keeps the FIRST 10, i.e. the original.
    expect(afterKeystroke).toBe(prefilled);
    expect(afterKeystroke.length).toBe(10);
  });
});
