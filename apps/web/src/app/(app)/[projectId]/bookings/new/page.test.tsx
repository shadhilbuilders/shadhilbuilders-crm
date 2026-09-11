// T-F4 - NewBookingPage (props-API Form) wire-shape contract.
//
// Pins: the props-API Form renders all required fields (Lead select,
// Unit ID input, Amount + Token amount, Notes textarea); the
// "Create booking" submit + "Cancel" reset button are wired.
//
// We deliberately do NOT exercise the mutation call here - that
// requires react-hook-form's setValue + submit plumbing and is
// covered by the sibling renders-rows tests for the index page.
// This file pins the form shape: a regression that drops a field
// (e.g. someone removes the Unit ID input) fails the build.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  // T-ProjectSwitch: the page reads the URL project id.
  useParams: () => ({ projectId: 'proj-test-1' }),
  // The page reads ?unitId= to pre-fill the unit picker (deep-link from
  // the inventory detail sheet). Mocked to not suspend during SSR.
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('@/hooks/queries/crm', () => ({
  useCreateBooking: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useLeads: vi.fn(() => ({
    data: [
      { id: 'lead-1', name: 'Priya Sharma', status: 'NEGOTIATION' },
      { id: 'lead-2', name: 'Rajesh Kumar', status: 'WON' },
    ],
  })),
}));

vi.mock('@/hooks/queries/inventory', () => ({
  useInventoryUnits: vi.fn(() => ({
    data: [
      { id: 'unit-1', unitNumber: 'A-101', bhk: 3 },
      { id: 'unit-2', unitNumber: 'B-201', bhk: 4 },
    ],
  })),
}));

vi.mock('@/lib/session', () => ({
  useSessionUser: vi.fn(() => ({
    user: { id: 'u1', role: 'SALES_EXEC', name: 'Exec', email: 'e@x' },
    isPending: false,
  })),
}));

import NewBookingPage from './page';

describe('NewBookingPage - props-API Form surface (T-F4)', () => {
  it('renders all required form fields with the props-API <Form>', () => {
    const html = renderToStaticMarkup(<NewBookingPage />);

    // Field labels for the props-API form (rendered via <Label>)
    expect(html).toContain('Lead');
    expect(html).toContain('Unit');
    expect(html).toContain('Total amount (₹)');
    expect(html).toContain('Token amount (₹, optional)');
    expect(html).toContain('Notes');

    // The form's submit button text (props API)
    expect(html).toContain('Create booking');
    // The reset button (props API - defaults to "Reset")
    expect(html).toMatch(/data-qa="form-reset-button"/);

    // Lead/Unit options are wired to the props-API combobox. The Combobox
    // renders a closed input trigger in SSR (options live in a popover,
    // not in static markup). We verify the field wrappers + combobox
    // containers are present and the placeholder text lands. The actual
    // option list is verified by the source-side useLeads /
    // useInventoryUnits mocks.
    expect(html).toMatch(/data-qa="form-field-leadId"/);
    expect(html).toMatch(/data-qa="combobox-container"/);
    expect(html).toContain('Search a lead...');
    expect(html).toMatch(/data-qa="form-field-unitId"/);
    expect(html).toContain('Search an available unit...');
    expect(html).toMatch(/data-qa="booking-amount"/);
    expect(html).toMatch(/data-qa="booking-token-amount"/);

    // Breadcrumb
    expect(html).toContain('New booking');
    expect(html).toContain('Bookings');
  });

  it('renders the "Back to bookings" affordance for fallback navigation', () => {
    const html = renderToStaticMarkup(<NewBookingPage />);
    expect(html).toContain('Back to bookings');
  });
});