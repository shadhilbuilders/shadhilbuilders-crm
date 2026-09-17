// LeadCoOwnerDialog - form body render tests.
//
// The Dialog shell is a Base UI portal (empty under renderToStaticMarkup),
// so per the repo rule the test targets the named export CoOwnerFormBody.
// Mirrors LeadReassignDialog.test.tsx: pins the visible labels + data-qa
// markers, the reason field (zod-required), and that the Form action
// section is hidden (footer owns submit / clear).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/apis/client', () => ({
  api: vi.fn(),
  qs: (p: Record<string, unknown>) => `?${new URLSearchParams(String(p)).toString()}`,
}));

// useUsers fetches the default-10 co-owner list; mock it (no QueryClient
// provider under renderToStaticMarkup).
vi.mock('@/hooks/queries/users', () => ({
  useUsers: vi.fn(() => ({ data: { rows: [] } })),
}));

import { CoOwnerFormBody } from './LeadCoOwnerDialog';

describe('CoOwnerFormBody', () => {
  const noopSubmit = () => undefined;

  it('renders the co-owner combobox (label + description) and the reason field', () => {
    const html = renderToStaticMarkup(
      <CoOwnerFormBody ownerId="owner-1" projectId={null} onSubmit={noopSubmit} />,
    );
    expect(html).toContain('Co-owner');
    expect(html).toContain('A second staff member who can work the lead.');
    expect(html).toContain('Reason');
    expect(html).toContain('data-qa="lead-co-owner-reason"');
  });

  it('shows the reason as required', () => {
    const html = renderToStaticMarkup(
      <CoOwnerFormBody ownerId="owner-1" projectId={null} onSubmit={noopSubmit} />,
    );
    expect(html).toContain('*');
  });

  it('hides the Form action section - Save lives in the Dialog footer', () => {
    const html = renderToStaticMarkup(
      <CoOwnerFormBody ownerId="owner-1" projectId={null} onSubmit={noopSubmit} />,
    );
    expect(html).not.toContain('data-qa="form-submit-button"');
    expect(html).not.toContain('data-qa="form-reset-button"');
    expect(html).not.toContain('data-qa="lead-co-owner-confirm"');
    expect(html).not.toContain('data-qa="lead-co-owner-clear"');
  });

  it('excludes the lead owner from the assignee picker', () => {
    const html = renderToStaticMarkup(
      <CoOwnerFormBody ownerId="owner-1" projectId={null} onSubmit={noopSubmit} />,
    );
    // The owner is never rendered as an option label.
    expect(html).not.toContain('(owner-1)');
  });
});
