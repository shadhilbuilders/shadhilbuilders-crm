// LeadReassignDialog - form body render tests.
//
// The Dialog shell is a Base UI portal (empty under renderToStaticMarkup),
// so per the repo rule the test targets the named export LeadReassignFormBody.
// Covers: visible labels + data-qa markers, no inline submit (footer owns it),
// and that the reason field is present (zod-required).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/apis/client', () => ({
  api: vi.fn(),
  qs: (p: Record<string, unknown>) => `?${new URLSearchParams(String(p)).toString()}`,
}));

// useUsers fetches the default-10 assignee list; mock it (no QueryClient
// provider under renderToStaticMarkup).
vi.mock('@/hooks/queries/users', () => ({
  useUsers: vi.fn(() => ({ data: { rows: [] } })),
}));

import { LeadReassignFormBody } from './LeadReassignDialog';

const lead = { id: 'lead-1', name: 'Priya Sharma' };

describe('LeadReassignFormBody', () => {
  const noopSubmit = () => undefined;

  it('renders the assignee combobox (label + description) and the reason field', () => {
    const html = renderToStaticMarkup(
      <LeadReassignFormBody
        currentOwnerId="owner-1"
        projectId={null}
        onSubmit={noopSubmit}
      />,
    );
    expect(html).toContain('Assign to');
    expect(html).toContain('Only telecallers / sales executives');
    expect(html).toContain('Reason');
    expect(html).toContain('data-qa="lead-reassign-reason"');
  });

  it('shows the reason as required', () => {
    const html = renderToStaticMarkup(
      <LeadReassignFormBody
        currentOwnerId="owner-1"
        projectId={null}
        onSubmit={noopSubmit}
      />,
    );
    expect(html).toContain('*');
  });

  it('hides the Form action section - Assign lives in the Dialog footer', () => {
    const html = renderToStaticMarkup(
      <LeadReassignFormBody
        currentOwnerId="owner-1"
        projectId={null}
        onSubmit={noopSubmit}
      />,
    );
    expect(html).not.toContain('data-qa="form-submit-button"');
    expect(html).not.toContain('data-qa="form-reset-button"');
    expect(html).not.toContain('data-qa="lead-reassign-confirm"');
  });

  it('uses the lead name only in the dialog shell (not the form body)', () => {
    const html = renderToStaticMarkup(
      <LeadReassignFormBody
        currentOwnerId="owner-1"
        projectId={null}
        onSubmit={noopSubmit}
      />,
    );
    expect(html).not.toContain(lead.name);
  });
});
