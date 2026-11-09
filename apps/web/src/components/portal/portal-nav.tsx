'use client';

// PortalNav: the buyer's bottom action bar.
//
// REDESIGN (2026-11-09, third pass). The bar previously held a single "Progress"
// link to /portal - the page the buyer was already on. A nav item that cannot
// navigate is decoration, so the slot now carries the one action this screen
// actually offers: Refresh, as the library <Button> in its primary color.
//
// NO CUSTOM BUTTON: @paalstack/react-ui Button already ships isLoading,
// loadingText, leftIcon and a Spinner, so this file renders it directly and
// keeps only the query plumbing (usePortalRefresh). The size is overridden to
// 44px because the library's default h-8 / lg h-9 are below the touch minimum
// this bar is held to.
//
// The ITEMS ARRAY is still honoured. When slice 3 adds Details, Payments and
// Docs, those render as links beside the action; `items` is how they arrive,
// and `action` is a separate slot so a future primary action does not have to
// masquerade as navigation.
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@paalstack/react-ui';
import { LuRefreshCw } from '@paalstack/react-icons/lu';

import { usePortalRefresh } from '@/hooks/use-portal-refresh';

export type PortalNavItem = {
  href: string;
  label: string;
  icon: ReactNode;
};

/**
 * Links only. Empty in this slice because Refresh is an action, not a
 * destination - the buyer's page identity lives in the record head, and a
 * nav item pointing at the current page navigates nowhere.
 */
export const PORTAL_NAV_ITEMS: readonly PortalNavItem[] = [];

/** Touch-target overrides: the library's heights stop at 36px. */
const TAP_TARGET = 'min-h-11 h-11 w-full rounded-full px-6 text-sm';

function RefreshAction() {
  const { busy, announcement, refresh } = usePortalRefresh();
  return (
    <>
      <Button
        type="button"
        label="Refresh"
        variant="solid"
        color="primary"
        size="lg"
        className={TAP_TARGET}
        leftIcon={<LuRefreshCw className="size-4" aria-hidden="true" />}
        isLoading={busy}
        loadingText="Refreshing…"
        onClick={() => void refresh()}
        aria-label="Refresh your progress"
        data-qa="portal-nav-refresh"
      />
      {/* Polite: a refresh is not an interruption, so it must not steal focus
          or interrupt whatever the screen reader is reading. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  );
}

export function PortalNav({
  items = PORTAL_NAV_ITEMS,
  action,
}: {
  items?: readonly PortalNavItem[];
  /** Replaces the default Refresh action when a slice needs something else. */
  action?: ReactNode;
}) {
  const hasLinks = items.length > 0;

  return (
    <nav
      aria-label="Portal"
      data-qa="portal-nav"
      className="sticky bottom-0 z-40 border-t border-[var(--portal-hair)] bg-[var(--portal-paper)] pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2"
    >
      <div className="mx-auto flex max-w-md items-center justify-center gap-1 px-4">
        {hasLinks ? (
          <ul
            className={
              'flex items-center ' +
              (action !== undefined ? 'flex-1 justify-start' : 'flex-1 justify-center')
            }
          >
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={item.href === '/portal' ? 'page' : undefined}
                  data-qa="portal-nav-item"
                  className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full px-3 text-sm font-medium text-[var(--portal-ink-2)] transition-colors duration-300 hover:text-[var(--portal-navy)] active:scale-[0.98]"
                >
                  {item.icon}
                  <span>{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {/* Solo action: max-w-xs + mx-auto so a capped button sits centered in
            the bar. Without mx-auto, w-full max-w-xs left-aligns once the bar
            is wider than 20rem. */}
        <div className={hasLinks ? 'shrink-0' : 'mx-auto w-full max-w-xs'}>
          {action !== undefined ? action : <RefreshAction />}
        </div>
      </div>
    </nav>
  );
}
