// PortalHero, the buyer's own phone line (2026-11-26).
//
// protects= the number the office holds is on the buyer's own page, tappable,
//           and formatted the same way every staff screen formats it;
// fails_when= the line renders when there is no number (an empty "we reach you
//           on" reads as a fault), the href carries the display spacing instead
//           of digits, or the country code is dropped from the dial link;
// no_claim= static markup only: it does not test the RLS read behind the value,
//           which is owned by packages/database/test/customer-self-phone.test.ts
//           and customer-portal.service.test.ts.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { PortalHero, type PortalHeroProps } from './portal-hero';

const base: PortalHeroProps = {
  customerName: 'Asha Rao',
  unitNumber: 'A-2',
  projectName: 'Metro Heights',
  latest: null,
  isLoading: false,
  onOpenPhoto: vi.fn(),
  now: Date.UTC(2026, 10, 26, 12, 0),
};

const render = (phone: string | null) =>
  renderToStaticMarkup(<PortalHero {...base} phone={phone} />);

describe('PortalHero phone line', () => {
  it('prints the stored number, dialable, with the country code intact', () => {
    const html = render('919876543210');

    expect(html).toContain('data-qa="portal-hero-phone"');
    expect(html).toContain('We reach you on');
    // Display follows the house formatter (98765 43210), the href is digits.
    expect(html).toContain('98765 43210');
    expect(html).toContain('href="tel:+919876543210"');
    // The display spacing must never reach the dial link.
    expect(html).not.toContain('tel:+9198765 43210');
  });

  it('renders nothing at all when there is no number', () => {
    const html = render(null);
    expect(html).not.toContain('portal-hero-phone');
    expect(html).not.toContain('We reach you on');
  });

  it('treats a blank or whitespace-only value as no number', () => {
    expect(render('')).not.toContain('portal-hero-phone');
    expect(render('   ')).not.toContain('portal-hero-phone');
  });

  it('still greets the buyer by name when the number is missing', () => {
    // The phone is an addition to the record head, never a condition of it.
    expect(render(null)).toContain('Hello, Asha Rao');
  });
});
