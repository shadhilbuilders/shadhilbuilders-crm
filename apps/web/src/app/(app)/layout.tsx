import { type ReactNode } from 'react';

import { AppHeader } from '@/components/app-header';

// Authenticated app shell. The proxy redirects cookieless visitors to
// /login before this layout ever renders, so everything inside is
// session-scoped UI.
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col">
      <AppHeader />
      <main className="container mx-auto w-full max-w-7xl flex-1 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6">
        {children}
      </main>
    </div>
  );
}