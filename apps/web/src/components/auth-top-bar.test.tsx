// AuthTopBar - wire-shape contract test (T-brand).
//
// renderToStaticMarkup-based (repo convention - no @testing-library).
// Covers: bar renders, brand chip + logo present, theme toggle mounted
// inside the bar, and the proxy PUBLIC_PATHS entry that lets the logo
// load unauthenticated (string-level check on proxy.ts - the proxy is
// an edge module; importing it in jsdom pulls next/server, so we assert
// the source-level contract instead).
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => (
    <img src={String(props.src)} alt={String(props.alt)} data-qa="auth-brand-logo" />
  ),
}));

vi.mock('@/components/theme-toggle', () => ({
  ThemeToggle: () => <button type="button" data-qa="theme-toggle">theme</button>,
}));

import { AuthTopBar } from './auth-top-bar';

describe('AuthTopBar (unauthenticated brand bar)', () => {
  it('renders the bar with brand chip + logo + theme toggle', () => {
    const html = renderToStaticMarkup(<AuthTopBar />);
    expect(html).toContain('data-qa="auth-topbar"');
    expect(html).toContain('data-qa="auth-brand"');
    expect(html).toContain('data-qa="auth-brand-logo"');
    expect(html).toContain('data-qa="theme-toggle"');
    // The transparent lockup asset is the source of truth (user
    // instruction: use logo.png everywhere).
    expect(html).toContain('/brand/logo.png');
    expect(html).not.toContain('logo-with-bg');
  });

  it('the logo asset is public in the auth proxy (unauthenticated pages can load it)', () => {
    // proxy.ts is an edge module (next/server imports) - assert the
    // source-level contract instead of importing it into jsdom.
    const src = readFileSync('src/proxy.ts', 'utf8');
    expect(src).toContain("'/brand'");
    // Both layers (function-body allowlist + matcher lookahead).
    expect(src).toMatch(/matcher:\s*\[\s*'[^\n]*brand[^\n]*'\s*,?\s*\]/);
  });

  it('the logo file exists in public/brand', () => {
    // If someone renames/moves the asset the auth pages lose their brand
    // silently - pin the path.
    const stat = readFileSync('public/brand/logo.png');
    expect(stat.length).toBeGreaterThan(10_000); // real PNG, not a stub
  });
});