'use client';

// Authenticated app shell - Phase 2.
//
// Wraps the (app) route group in `SidebarProvider` from @paalstack/react-ui.
// The library handles the mobile / desktop breakpoint internally: ≤768px
// the Sidebar becomes a Sheet (slide-in from the left), ≥768px it's a
// persistent inset rail. The cookie-persisted `sidebar_state` defaults to
// `true` on desktop so first-paint is "open and readable", and to
// `false` on mobile so the first paint is "hamburger + page" rather than
// a Sheet overlay flashing over a fresh route (T30 - the cookie SSR
// flash was a re-review landmine).
//
// Architecture note (Eng-review Section 1 P1): this layout is
// deliberately a client component. The proxy middleware
// (`apps/web/src/proxy.ts`) redirects cookieless visitors to /login
// before this layout ever renders, so SSR is unnecessary here. Trying
// to split server/client would re-introduce a "shell appears before
// session" flash that the client-only path avoids entirely.
//
// ASCII layout (matches plan §3.1):
//
//   SidebarProvider defaultOpen=isDesktop   (set after mount to avoid
//   │                                         a mobile-vs-desktop
//   │                                         cookie flash)
//   ├── <AppShell>                         (logo, nav groups, footer)
//   └── <SidebarInset>                     (replaces the old <main>)
//       ├── <AppHeader>                    (slim topbar - T8 rewrites it)
//       │   ├── SidebarTrigger             (mobile only, opens the Sheet)
//       │   └── <OnlineRevalidationBar />  (D6: fixed at top of inset)
//       └── <main>{children}</main>
import { Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { SidebarInset, SidebarProvider } from '@paalstack/react-ui';

import { AppShell } from '@/components/app-shell';
import { AppHeader } from '@/components/app-header';
import { Skeleton } from '@/components/shared/Skeleton';
import { usePushSubscription } from '@/hooks/use-push-subscription';

const DESKTOP_BREAKPOINT_QUERY = '(min-width: 768px)';

function useIsDesktop(): boolean {
  // Start `true` on the server so SSR markup matches the default-open
  // desktop path; reconcile with the actual viewport after mount. The
  // cookie is read on the client only, so there is no SSR-vs-CSR
  // hydration mismatch from this hook.
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(DESKTOP_BREAKPOINT_QUERY);
    setIsDesktop(mql.matches);
    const onChange = (event: MediaQueryListEvent) => {
      setIsDesktop(event.matches);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isDesktop;
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const isDesktop = useIsDesktop();
  // T-PUSH: subscribe this device to web push once the authenticated shell
  // mounts (best-effort - no-ops if push is unsupported/disabled).
  usePushSubscription();
  // Mobile: defaultOpen=false so the first paint shows the page, not a
  // Sheet overlay. Desktop: defaultOpen=true so the rail is visible
  // immediately. The library cookie-persists the user-toggle so this
  // initial value only matters on first visit.
  return (
    <SidebarProvider defaultOpen={isDesktop}>
      <AppShell />
      <SidebarInset className='md:peer-data-[variant=inset]:mt-0'>
        <Suspense fallback={<Skeleton variant="text" count={1} className="h-14 w-full" />}>
          <AppHeader />
        </Suspense>
        <main className="w-full flex-1 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
