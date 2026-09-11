'use client';

// AuthenticatedShell - the client app shell (sidebar + topbar + main).
//
// Previously this WAS the `[orgId]/layout.tsx` (a client layout). With the
// slug-based URL scheme the tenant resolution moved to the server
// OrgLayout (`[orgSlug]/layout.tsx`); the client shell is extracted here and
// rendered INSIDE the OrganizationProvider so the sidebar/topbar can consume
// the resolved org. No layout/order change - SidebarProvider > AppShell >
// SidebarInset > AppHeader + main, exactly as before.
import { Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { SidebarInset, SidebarProvider } from '@paalstack/react-ui';

import { AppShell } from '@/components/app-shell';
import { AppHeader } from '@/components/app-header';
import { Skeleton } from '@/components/shared/Skeleton';
import { usePushSubscription } from '@/hooks/use-push-subscription';

const DESKTOP_BREAKPOINT_QUERY = '(min-width: 768px)';

function useIsDesktop(): boolean {
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

export function AuthenticatedShell({ children }: { children: ReactNode }) {
  const isDesktop = useIsDesktop();
  // T-PUSH: subscribe this device to web push once the authenticated shell
  // mounts (best-effort - no-ops if push is unsupported/disabled).
  usePushSubscription();

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
