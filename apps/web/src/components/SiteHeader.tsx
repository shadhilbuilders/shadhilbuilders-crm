// Minimal header — Phase 1 placeholder. Real nav comes in Phase 2.
import Link from 'next/link';

import { env } from '@/lib/env/env';

export const SiteHeader = () => {
  return (
    <header className="border-border border-b">
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <Link href="/" className="font-semibold text-primary">
          {env.NEXT_PUBLIC_APP_NAME}
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/api/docs" className="text-muted-foreground hover:text-foreground">
            API Docs
          </Link>
        </nav>
      </div>
    </header>
  );
};
