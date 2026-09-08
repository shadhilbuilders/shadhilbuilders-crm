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

import { LeadEditFormBody } from './LeadEditDialog';

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