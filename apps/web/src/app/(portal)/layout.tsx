'use client';

// Portal layout (issue #8 slice 2, D6/D7 + D3 password gate). Lives OUTSIDE
// /[orgSlug]: a buyer has no staff org home, and no staff role previews the
// portal.
//
// Client guard on the session (courtesy only - RLS and the API's 403s are the
// real wall): no session -> /login?next=/portal, any staff role -> /, and a
// buyer still holding their temporary password -> /portal/change-password.
// The last one is why `portalGateFor` answers all three: this is ONE effect and
// one redirect, so a gated buyer never sees the portal render first and bounce
// second.
//
// REDESIGN (2026-11-09, second pass): the page is now a ruled document on warm
// paper rather than a stack of glass pills, so `portal-grain` is the only
// decorative layer and the container is a 12-column-friendly max-w-6xl.
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { PageLoading } from '@/components/shared/PageLoading';
import { PORTAL_FONT_VARIABLES } from '@/components/portal/portal-fonts';
import { PortalHeader } from '@/components/portal/portal-header';
import { PortalNav } from '@/components/portal/portal-nav';
import { PORTAL_CHANGE_PASSWORD, portalGateFor } from '@/lib/portal-routing';
import { useSessionUser } from '@/lib/session';

/** Puts the portal theme + font variables on <html> while the portal is
 *  mounted: dialogs and the photo viewer portal into <body>, outside any
 *  wrapper, and must still read the editorial tokens. Removed on unmount so
 *  the staff app is never affected. */
function usePortalThemeScope(): void {
  useEffect(() => {
    const root = document.documentElement;
    const classes = ['portal-theme', ...PORTAL_FONT_VARIABLES.split(' ')];
    root.classList.add(...classes);
    return () => root.classList.remove(...classes);
  }, []);
}

export default function PortalLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isPending } = useSessionUser();

  usePortalThemeScope();

  const bounceTo = isPending
    ? null
    : portalGateFor({
        role: user?.role,
        mustChangePassword: user?.mustChangePassword ?? false,
        pathname: pathname ?? '',
      });

  useEffect(() => {
    if (bounceTo !== null) router.replace(bounceTo);
  }, [bounceTo, router]);

  if (isPending || bounceTo !== null) return <PageLoading content="Opening your portal..." />;

  // The bottom bar's only action is Refresh, which invalidates the
  // customer-portal queries. On the rotation screen those requests are 403
  // PASSWORD_CHANGE_REQUIRED by design, so offering it would be an action that
  // cannot succeed. The masthead stays - that is where Sign out lives.
  const onRotationRoute = pathname === PORTAL_CHANGE_PASSWORD;

  return (
    <div
      className={`${PORTAL_FONT_VARIABLES} portal-theme portal-grain relative flex min-h-dvh flex-col bg-(--portal-paper) text-foreground antialiased`}
    >
      <PortalHeader name={user?.name} />
      <main className="relative z-10 mx-auto w-full max-w-6xl flex-1 px-4 pt-5 pb-10 text-[0.9375rem] sm:px-10">
        {children}
      </main>
      {onRotationRoute ? null : <PortalNav />}
    </div>
  );
}
