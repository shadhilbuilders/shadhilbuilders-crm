import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PhoneNumber } from './PhoneNumber';

describe('PhoneNumber', () => {
  it('renders masked +91 unchanged (text variant)', () => {
    const html = renderToStaticMarkup(<PhoneNumber phone="+919****3210" />);
    expect(html).toContain('+919****3210');
  });
  it('formats real +91', () => {
    const html = renderToStaticMarkup(<PhoneNumber phone="+919876543210" />);
    expect(html).toContain('+91 98765 43210');
  });
});
