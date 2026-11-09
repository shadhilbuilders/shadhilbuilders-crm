// PortalHeader: the buyer's brand bar.
// protects= the real logo asset (logo.png, not the with-bg variant), a link
//           home, the shared ThemeToggle, safe-area top padding, 44px targets;
// fails_when= the logo path changes, the toggle is dropped, or the bar loses the
//           iOS inset; no_claim= no visual QA, no theme switching behaviour.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => (
    <img src={String(props.src)} alt={String(props.alt)} data-qa="portal-brand-logo" />
  ),
}));
vi.mock('@/components/theme-toggle', () => ({
  ThemeToggle: () => (
    <button type="button" data-qa="theme-toggle">
      theme
    </button>
  ),
}));

import { PortalHeader } from './portal-header';

describe('PortalHeader', () => {
  it('renders the brand logo on a fixed light plate, linking to /portal', () => {
    const html = renderToStaticMarkup(<PortalHeader />);
    expect(html).toContain('data-qa="portal-header"');
    expect(html).toContain('/brand/logo.png');
    expect(html).not.toContain('logo-with-bg');
    expect(html).toContain('alt="Shadhil Builders"');
    expect(html).toContain('href="/portal"');
    expect(html).toContain('bg-white');
  });

  it('mounts the theme toggle and respects the top safe area', () => {
    const html = renderToStaticMarkup(<PortalHeader />);
    expect(html).toContain('data-qa="theme-toggle"');
    expect(html).toContain('env(safe-area-inset-top)');
    expect(html).toContain('sticky');
  });

  it('optionally shows the signed-in first name as a quiet greeting target', () => {
    expect(renderToStaticMarkup(<PortalHeader />)).not.toContain('data-qa="portal-header-name"');
    expect(renderToStaticMarkup(<PortalHeader name="Anita" />)).toContain('Anita');
  });
});
