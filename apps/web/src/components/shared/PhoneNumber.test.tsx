import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PhoneNumber } from './PhoneNumber';

describe('PhoneNumber', () => {
  it('renders masked +91 unchanged (text variant)', () => {
    const html = renderToStaticMarkup(<PhoneNumber phone="+919****3210" />);
    expect(html).toContain('+919****3210');
  });
  it('formats a domestic number in the shared national format', () => {
    // 2026-11-22: display comes from the shared formatter, which shows a
    // domestic number WITHOUT the country code (only foreign numbers carry it,
    // so they cannot read as local ones).
    const html = renderToStaticMarkup(<PhoneNumber phone="+919876543210" />);
    expect(html).toContain('98765 43210');
  });
});
