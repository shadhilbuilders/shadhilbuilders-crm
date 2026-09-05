'use client';

// AuthTopBar — shared brand header for every UNAUTHENTICATED page.
//
// Surfaces that render it: /login, /change-password, /offline,
// not-found. Authenticated pages use the AppShell sidebar +
// AppHeader instead (this component is intentionally NOT mounted
// there — the sidebar owns brand there).
//
// Left: logo-with-bg.png inside a fixed-height row — the asset is a
// full horizontal lockup (wordmark + tagline on a white tile), so it
// renders as a rounded, bordered chip whose height drives the scale;
// the tagline stays legible because the chip is 40px tall, unlike the
// 28px sidebar mark where the tagline smudges.
// Right: the ThemeToggle icon button (the same one the authenticated
// topbar uses) — theme is switchable BEFORE sign-in too, since the
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
// (min-h + centering) stays the page's responsibility so /offline
// can keep its shorter min-h-[60vh] etc.
import Image from 'next/image';

import { ThemeToggle } from '@/components/theme-toggle';

export function AuthTopBar() {
  return (
    <header
      data-qa="auth-topbar"
      className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/75 sticky top-0 z-40 border-b backdrop-blur"
    >
      <div className="container mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2" data-qa="auth-brand">
          {/* Full lockup on a white chip: the asset has an opaque white
              canvas, so it must NOT blend into a themed surface — give
              it a card-like rounded tile that looks intentional in both
              themes. height=9 (36px) keeps the wordmark crisp. */}
          <span className="border-border bg-card inline-flex h-10 items-center overflow-hidden rounded-md border px-2.5">
            <Image
              src="/brand/logo-with-bg.png"
              alt="Shadhil Builders"
              width={110}
              height={40}
              priority
              className="h-8 w-auto object-contain"
              data-qa="auth-brand-logo"
            />
          </span>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}