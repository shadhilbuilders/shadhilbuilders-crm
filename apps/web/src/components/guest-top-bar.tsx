'use client';

// GuestTopBar - shared brand header for every guest-facing page.
//
// Surfaces that render it: (guest) routes (/login,
// /change-password, /offline), not-found. Authenticated pages use the
// AppShell sidebar + AppHeader instead (this component is intentionally
// NOT mounted there - the sidebar owns brand there).
//
// Left: logo-with-bg.png inside a fixed-height row - the asset is a
// full horizontal lockup (wordmark + tagline on a white tile), so it
// renders as a rounded, bordered chip whose height drives the scale;
// the tagline stays legible because the chip is 40px tall, unlike the
// 28px sidebar mark where the tagline smudges.
// Right: the ThemeToggle icon button (the same one the authenticated
// topbar uses) - theme is switchable BEFORE sign-in too, since the
// OS default can be wrong and the user shouldn't have to authenticate
// to fix eye-gouging contrast.
//
// Layout: the inner row uses the app's standard container pattern
// (`container mx-auto w-full max-w-7xl px-4`, same as
// (app)/layout.tsx) so the bar's content aligns with the app content
// column on wide screens instead of hugging the viewport edge.
//
// The bar is deliberately minimal: no nav links (an unauthenticated
// visitor has nowhere else to go), no user menu. Layout wrapper
// (min-h + centering) lives in (guest)/layout.tsx so each page
// only renders its own content.
import Image from 'next/image';

import { ThemeToggle } from '@/components/theme-toggle';
import Link from 'next/link';

export function GuestTopBar() {
  return (
    <header
      data-qa="guest-topbar"
      className="border-border bg-background/95 supports-backdrop-filter:bg-background/75 sticky top-0 z-40 border-b backdrop-blur"
    >
      <div className="container mx-auto flex h-19 w-full max-w-7xl items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2 h-15" data-qa="guest-brand">
          {/* Transparent lockup (logo.png - tight 4% padding, wordmark +
              tagline) on a FIXED LIGHT chip: the PNG's navy letters are
              hard-coded, so the surface behind them must stay light in
              both themes. bg-card is theme-dependent (near-black in dark
              mode → navy-on-navy contrast failure, found in-browser);
              bg-white + a subtle border reads as a brand plate instead. */}
          <Link href="/" className="border-border bg-white my-1 inline-flex h-full items-center overflow-hidden rounded-lg border px-3 py-2 dark:bg-white">
            <Image
              src="/brand/logo.png"
              alt="Shadhil Builders"
              width={140}
              height={42}
              priority
              className="h-12 w-auto object-contain"
              data-qa="guest-brand-logo"
              loading="eager"
            />
          </Link>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
