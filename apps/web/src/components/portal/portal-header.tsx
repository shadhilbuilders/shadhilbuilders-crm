'use client';

// PortalHeader: the buyer's masthead.
//
// REDESIGN (2026-11-09, second pass): the floating glass pill is gone. It was
// generic app chrome sitting on top of an editorial page, and it made the real
// brand mark read like a thumbnail in a bubble. This is now a ruled masthead:
// the logo sits directly on the page, one hairline closes it, and the bar
// scrolls away instead of sticking. Nothing here is glass, nothing is blurred.
//
// The real asset is public/brand/logo.png (transparent RGBA, navy #011B4D +
// green #63B233). It keeps a white plate because the navy letters are
// hard-coded and dark mode would swallow them (same rule as GuestTopBar).
import Image from 'next/image';
import Link from 'next/link';

import { ThemeToggle } from '@/components/theme-toggle';

export function PortalHeader({ name }: { name?: string | null }) {
  // Full name, whitespace-collapsed: the masthead is the only place the buyer
  // sees who the portal is signed in as, so it must not be a partial identity.
  const fullName = name?.trim().replace(/\s+/g, ' ') ?? '';
  return (
    <header
      data-qa="portal-header"
      className="portal-hairline-b sticky top-0 z-40 bg-(--portal-paper) px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-1.5 sm:px-10"
    >
      {/* TIGHTENED (2026-11-09): the taller logo pushed the header from 77px to
          93px. `py-3` on the inner row plus the plate's own `py-1.5` stacked
          two paddings around a 48px mark. The row is now flush and the plate
          supplies the only vertical padding, so the mark keeps its size and the
          bar gives the 16px back. */}
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
        <Link
          href="/portal"
          className="inline-flex min-h-11 items-center rounded-sm bg-(--portal-tint) px-3 py-1 focus-visible:ring-2 focus-visible:ring-(--portal-navy) focus-visible:ring-offset-2 focus-visible:outline-none dark:bg-white"
        >
          <Image
            src="/brand/logo.png"
            alt="Shadhil Builders"
            width={280}
            height={84}
            priority
            loading="eager"
            className="h-9 w-auto object-contain sm:h-12"
            data-qa="portal-brand-logo"
          />
        </Link>
        <div className="flex items-center gap-3">
          {fullName.length > 0 ? (
            <span
              data-qa="portal-header-name"
              title={fullName}
              className="hidden max-w-56 truncate text-sm text-(--portal-ink-2) sm:block"
            >
              {fullName}
            </span>
          ) : null}
          <ThemeToggle className="size-9 min-h-9 min-w-9 rounded-full p-0 sm:size-11 sm:min-h-11 sm:min-w-11" />
        </div>
      </div>
    </header>
  );
}
