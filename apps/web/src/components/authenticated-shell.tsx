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
import { PushEnablePrompt } from '@/components/push-enable-prompt';
import { Skeleton } from '@/components/shared/Skeleton';
import { PageLoading } from '@/components/shared/PageLoading';
import { usePathname, useRouter } from 'next/navigation';
import { isFullBleedPath } from '@/lib/nav';
import { redirectForArea } from '@/lib/portal-routing';
import { useSessionUser } from '@/lib/session';

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
  const router = useRouter();
  const pathname = usePathname();
  // The site capture screen owns its header + safe-area; render it full-bleed.
  const fullBleed = isFullBleedPath(pathname ?? '');
  const { user } = useSessionUser();
  // Issue #8 (D6/D7): the staff shell never renders for a CUSTOMER. Bounce to
  // the portal and render nothing staff-shaped in the meantime.
  const bounceTo = user === null ? null : redirectForArea('staff', user.role);

  useEffect(() => {
    if (bounceTo !== null) router.replace(bounceTo);
  }, [bounceTo, router]);

  if (bounceTo !== null) return <PageLoading content="Opening your portal..." />;

  return (
    <SidebarProvider defaultOpen={isDesktop}>
      <AppShell />
      <SidebarInset className="md:peer-data-[variant=inset]:mt-0">
        {fullBleed ? null : (
          <Suspense fallback={<Skeleton variant="text" count={1} className="h-14 w-full" />}>
            <AppHeader />
          </Suspense>
        )}
        <main
          className={
            fullBleed
              ? 'w-full flex-1'
              : 'w-full flex-1 px-4 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]'
          }
        >
          {children}
        </main>
      </SidebarInset>
      {/* T-PUSH consent: ask the user to enable web push via an AlertDialog
          (only when it's supported + not yet enabled + not dismissed). */}
      <PushEnablePrompt />
    </SidebarProvider>
  );
}
