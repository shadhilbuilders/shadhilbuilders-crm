// PortalNav (issue #8 slice 2): the buyer's bottom navigation.
//
// One item in this slice (Progress). It takes an ITEMS ARRAY so slice 3 adds
// Details, Payments and Docs by appending entries, not by rewriting this
// component. With a single item it renders as a centred pill - a lone tab
// stretched across the full bar reads as a broken layout.
import type { ReactNode } from 'react';
import { LuHardHat } from '@paalstack/react-icons/lu';

export type PortalNavItem = {
  href: string;
  label: string;
  icon: ReactNode;
};

export const PORTAL_NAV_ITEMS: readonly PortalNavItem[] = [
  { href: '/portal', label: 'Progress', icon: <LuHardHat className="size-5" aria-hidden="true" /> },
];

export function PortalNav({
  items = PORTAL_NAV_ITEMS,
  activeHref,
}: {
  items?: readonly PortalNavItem[];
  activeHref: string;
}) {
  const single = items.length === 1;
  return (
    <nav
      aria-label="Portal"
      data-qa="portal-nav"
      className="border-border bg-background sticky bottom-0 border-t pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2"
    >
      <ul className={single ? 'flex justify-center' : 'grid auto-cols-fr grid-flow-col'}>
        {items.map((item) => {
          const active = item.href === activeHref;
          return (
            <li key={item.href} className={single ? '' : 'flex justify-center'}>
              <a
                href={item.href}
                aria-current={active ? 'page' : undefined}
                data-qa="portal-nav-item"
                className={
                  'flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full px-5 text-base font-medium ' +
                  (active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')
                }
              >
                {item.icon}
                <span>{item.label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
