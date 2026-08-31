// Minimal header — Phase 1 placeholder. Real nav comes in Phase 2.
import Link from 'next/link';

import { env } from '@/lib/env/env';

export const SiteHeader = () => {
  return (
    <header className="border-border border-b">
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        {/* Touch targets: min-h-11 (44px) per iOS HIG / WCAG 2.5.8; the
            padding extends the tappable area without changing visuals. */}
        <Link
          href="/"
          className="text-primary -ml-2 inline-flex min-h-11 items-center px-2 font-semibold"
        >
          {env.NEXT_PUBLIC_APP_NAME}
        </Link>
        <nav className="flex items-center gap-2 text-sm sm:gap-4">
          <Link
            href="/api/docs"
            className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center px-3"
          >
            API Docs
          </Link>
        </nav>
      </div>
    </header>
  );
};
