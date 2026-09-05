'use client';

// Floating "+ Add lead" CTA, role-gated.
//
// Plan D4: a Floating Action Button is the canonical mobile-first
// primary action surface. On desktop, the same action lives in the
// topbar/page header, so the FAB is `md:hidden`. On mobile (<768px),
// the FAB sits bottom-right with `safe-area-inset-bottom` already
// handled by the layout's padding.
//
// Eng-review Section 4 [P1]: "FAB silent-offline" - the FAB must hide
// when the browser is offline so a user on a flaky 4G connection
// doesn't tap "+ Add lead" and get a 504 from the BFF. `shouldShowFab`
// encodes that rule as a pure function so it can be exhaustively
// tested without rendering.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LuPlus } from '@paalstack/react-icons/lu';
import { Button } from '@paalstack/react-ui';

import type { Role } from '@/apis/client';
import { canReassign } from '@/lib/session';

const FAB_PATHNAME_PREFIXES = ['/leads'] as const;

/**
 * Pure predicate for whether the FAB should be visible. Decoupled from
 * React so the test in `floating-action-button.test.ts` (T5) can assert
 * every role × route combination without rendering.
 *
 * Rule (D4 + Eng-review Section 4):
 *   - Pathname must start with `/leads` (covers `/leads` and `/leads/[id]`)
 *   - Role must be allowed to log lead activity (telecaller / sales exec
 *     / manager / admin / owner). `canReassign` is the closest canonical
 *     helper; telecaller + sales exec are the staff-side operators that
 *     actually create leads, manager+ can move them between teams.
 *   - Browser must be online. Offline → FAB hides so users don't queue
 *     a tap that will 504 (the offline-queue handles `Lead`-creation
 *     mutations once that ships, but the FAB UX today is "no crash").
 */
export function shouldShowFab(
  role: Role | undefined,
  pathname: string,
  isOnline: boolean,
): boolean {
  if (!isOnline) return false;
  if (role === undefined) return false;
  if (!canReassign(role)) return false;
  return FAB_PATHNAME_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function useOnlineStatus(): boolean {
  // Default to true so SSR doesn't flicker; sync to navigator.onLine
  // after mount. The `online`/`offline` listeners keep it fresh.
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    setOnline(navigator.onLine);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return online;
}

export type FloatingActionButtonProps = {
  role: Role | undefined;
  /** Defaults to `/leads/new`. */
  href?: string;
};

/**
 * Render the FAB. The visibility predicate and the network hook do the
 * heavy lifting; this component is a thin `<Link>` wrapped in a sized
 * `<Button>`.
 */
export function FloatingActionButton({
  role,
  href = '/leads/new',
}: FloatingActionButtonProps) {
  const pathname = usePathname();
  const online = useOnlineStatus();

  if (!shouldShowFab(role, pathname, online)) return null;

  return (
    <Button
      asChild
      size="icon"
      className="bg-primary text-primary-foreground hover:bg-primary/90 fixed right-4 bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-50 h-14 w-14 rounded-full shadow-lg md:hidden"
      aria-label="Add a new lead"
    >
      <Link href={href}>
        <LuPlus className="h-6 w-6" />
      </Link>
    </Button>
  );
}
