'use client';

// InventoryRouteGate (2026-11-08): the /inventory surface is CLOSED to
// site-only roles, not merely unlinked from their nav.
//
// WHY A GATE AND NOT A REDIRECT: `/inventory` advertises per-sq.ft price, total
// price and booking state for every villa. A redirect still mounts the page for
// one tick, and the grid's queries (`useInventoryUnits`) fire on mount - so the
// rupees reach an engineer's browser even if the screen is swapped a frame
// later. This wrapper decides BEFORE the children render, so the queries never
// run and no money data is ever requested. It is a block, not a detour.
//
// WHY THE LAYOUT: it sits in `inventory/layout.tsx`, so `/inventory`,
// `/inventory/new` and `/inventory/phases` are all covered by one gate. Adding
// it per page would leave the next inventory route unguarded by default.
//
// WHO IS BLOCKED: only `isSiteOnlyRole` (ENGINEER). TELECALLER is a site role
// but reads the grid as part of the lead job, with the money columns hidden -
// blocking them would remove a surface they need. Sales and admin roles are
// untouched.
//
// The panel names the role's OWN surface and links to it. A hard block without
// an exit is a dead end; the point is "this is not your screen", and the
// engineer's screen is one tap away.
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';

import { Button, Empty } from '@paalstack/react-ui';
import { LuCamera } from '@paalstack/react-icons/lu';

import { Skeleton } from '@/components/shared/Skeleton';
import { projectHref } from '@/lib/nav';
import { isSiteOnlyRole, useSessionUser } from '@/lib/session';
import { useOrgSlug, useProjectSlug } from '@/lib/tenant-context';

export function InventoryRouteGate({ children }: { children: ReactNode }) {
  const { user, isPending } = useSessionUser();
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();

  // Same hydration gate as the pages: better-auth reports isPending during SSR,
  // so rendering a role-dependent branch on the server would either mismatch on
  // hydration or paint the grid before the role is known.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || isPending) {
    return <Skeleton variant="table" isOffline={false} />;
  }

  if (user !== null && isSiteOnlyRole(user.role)) {
    return (
      <div className="mx-auto max-w-lg py-16" data-qa="inventory-blocked">
        <Empty
          media={<LuCamera className="size-full" />}
          mediaVariant="icon"
          title="Inventory is not part of your work"
          description="You document progress on site. Villa prices and booking status are not part of that job."
        />
        <div className="mt-4 flex justify-center">
          <Button
            as={Link}
            href={projectHref(orgSlug, projectSlug, '/site')}
            data-qa="inventory-blocked-site-link"
          >
            Go to Site updates
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
