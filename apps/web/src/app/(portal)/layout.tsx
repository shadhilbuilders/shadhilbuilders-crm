'use client';

// Portal layout (issue #8 slice 2, D6/D7). Lives OUTSIDE /[orgSlug]: a buyer
// has no staff org home, and no staff role previews the portal.
//
// Client guard on the session role (courtesy only - RLS and the API's 403s
// are the real wall): no session -> /login?next=/portal, any staff role -> /.
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import { PageLoading } from '@/components/shared/PageLoading';
import { PortalNav } from '@/components/portal/portal-nav';
import { redirectForArea } from '@/lib/portal-routing';
import { useSessionUser } from '@/lib/session';

export default function PortalLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, isPending } = useSessionUser();

  const bounceTo = isPending ? null : redirectForArea('portal', user?.role);

  useEffect(() => {
    if (bounceTo !== null) router.replace(bounceTo);
  }, [bounceTo, router]);

  if (isPending || bounceTo !== null) return <PageLoading content="Opening your portal..." />;

  return (
    <div className="bg-background text-foreground flex min-h-dvh flex-col">
      <header className="border-border border-b px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <p className="text-lg font-semibold">Shadhil Builders</p>
      </header>
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-6 text-base">{children}</main>
      <PortalNav activeHref="/portal" />
    </div>
  );
}
