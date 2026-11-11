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
// PortalSignOut pulls in useSignOut (better-auth) and the library AlertDialog;
// stub it to a marker - the control's own contract is covered in
// portal-sign-out.test.tsx, and this file only cares that the masthead mounts
// it.
vi.mock('./portal-sign-out', () => ({
  PortalSignOut: () => (
    <button type="button" data-qa="portal-sign-out">
      sign out
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

  it('optionally shows the signed-in full name as a quiet greeting target', () => {
    expect(renderToStaticMarkup(<PortalHeader />)).not.toContain('data-qa="portal-header-name"');
    expect(renderToStaticMarkup(<PortalHeader name="Anita" />)).toContain('Anita');
  });

  // 2026-11-10: the masthead is the buyer's only exit from the product (a
  // CUSTOMER is bounced out of every staff surface, and the bottom bar holds a
  // single Refresh action). It must therefore be mounted here, and it must sit
  // AFTER the theme toggle so the exit is the rightmost control in the row.
  it('mounts sign out after the theme toggle', () => {
    const html = renderToStaticMarkup(<PortalHeader name="Anita" />);
    expect(html).toContain('data-qa="portal-sign-out"');
    const themeAt = html.indexOf('data-qa="theme-toggle"');
    const signOutAt = html.indexOf('data-qa="portal-sign-out"');
    expect(themeAt).toBeGreaterThan(-1);
    expect(signOutAt).toBeGreaterThan(themeAt);
  });

  // The masthead names the signed-in buyer in full (2026-11-10), so a two-word
  // name is not truncated to its first token, and stray internal whitespace in
  // the stored name does not reach the bar.
  it('shows the whole name, whitespace collapsed', () => {
    const html = renderToStaticMarkup(<PortalHeader name="  Anita   Rao  " />);
    expect(html).toContain('Anita Rao');
    expect(html).not.toContain('Anita   Rao');
    expect(html).not.toContain('>Anita<');
    // The truncated bar keeps the full value reachable as a tooltip.
    expect(html).toContain('title="Anita Rao"');
  });
});
