// NewUnitPage (props-API Form) wire-shape contract.
//
// Pins: the props-API Form renders all required fields (Phase select,
// Unit number, BHK, Facing, Sqft, Price); the "Create unit" submit +
// "Cancel" reset button are wired.
//
// T-INV-SYNC (2026-09-15): the Status select is GONE from this form on
// purpose. Unit.status is derived from the booking lifecycle, so a new unit
// is always created AVAILABLE - it cannot be seeded into HOLD/TOKEN/SOLD by
// hand. See migration 20260915060000_unit_status_sync.
//
// We deliberately do NOT exercise the mutation call here - that
// requires react-hook-form's setValue + submit plumbing. This file pins
// the form shape: a regression that drops a field fails the build.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  // T-ProjectSwitch: the page reads the URL project id.
  useParams: () => ({ projectId: 'proj-test-1' }),
}));

vi.mock('@/hooks/queries/inventory', () => ({
  useCreateUnit: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useInventoryPhases: vi.fn(() => ({
    data: [
      { id: 'phase-1', projectId: 'proj-test-1', name: 'Phase A', unitCount: 5 },
      { id: 'phase-2', projectId: 'proj-test-1', name: 'Phase B', unitCount: 3 },
    ],
  })),
  useProjectOptions: vi.fn(() => ({
    data: [
      { id: 'o1', projectId: 'proj-test-1', type: 'FACING', value: 'North', unitCount: 4 },
      { id: 'o2', projectId: 'proj-test-1', type: 'BHK', value: '1', unitCount: 0 },
      { id: 'o3', projectId: 'proj-test-1', type: 'BHK', value: '2', unitCount: 2 },
      { id: 'o4', projectId: 'proj-test-1', type: 'BHK', value: '3', unitCount: 5 },
    ],
  })),
}));

import NewUnitPage from './page';

describe('NewUnitPage - props-API Form surface', () => {
  it('renders all required form fields with the props-API <Form>', () => {
    const html = renderToStaticMarkup(<NewUnitPage />);

    // Field labels for the props-API form (rendered via <Label>)
    expect(html).toContain('Phase');
    expect(html).toContain('Unit number');
    expect(html).toContain('BHK');
    expect(html).toContain('Facing');
    expect(html).toContain('Sqft');
    expect(html).toContain('Price (₹)');
    // Status is intentionally absent - always AVAILABLE on create (T-INV-SYNC).
    expect(html).not.toMatch(/data-qa="unit-status"/);

    // The form's submit button text (props API)
    expect(html).toContain('Create unit');
    // The reset button (props API - defaults to "Reset")
    expect(html).toMatch(/data-qa="form-reset-button"/);

    // Phase options are wired to the props-API select. The Select
    // component renders a closed button trigger in SSR (options live
    // in a popover, not in static markup). We verify the phaseId
    // select field is present and the trigger placeholder is the
    // expected 'Pick a phase' string.
    expect(html).toMatch(/data-qa="form-field-phaseId"/);
    expect(html).toMatch(/data-qa="select-trigger"/);
    expect(html).toContain('Pick a phase');

    // Test IDs from the field props - proves the props-API
    // forwarded the data-qa attribute correctly (regression canary).
    expect(html).toMatch(/data-qa="unit-number"/);
    expect(html).toMatch(/data-qa="unit-sqft"/);
    expect(html).toMatch(/data-qa="unit-price"/);

    // BHK and Facing are Selects (bounded pickers from the shared
    // constants). The Select trigger hardcodes data-qa="select-trigger"
    // (custom selectProps.data-qa is dropped), so assert on the field
    // wrapper data-qa instead.
    expect(html).toMatch(/data-qa="form-field-bhk"/);
    expect(html).toMatch(/data-qa="form-field-facing"/);

    // Breadcrumb
    expect(html).toContain('New unit');
    expect(html).toContain('Inventory');
  });

  it('renders the "Back to Inventory" affordance for fallback navigation', () => {
    const html = renderToStaticMarkup(<NewUnitPage />);
    expect(html).toContain('Back to Inventory');
  });
});
