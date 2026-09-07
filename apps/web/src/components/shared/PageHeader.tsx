// PageHeader - shared header block for authenticated (app) routes.
//
// Per plan §3.3, every page in the (app) route group renders the same
// header shape: breadcrumb on top, page title + optional action
// underneath, separated from page content by a border. Pages already
// have an inline `<Heading>` + `<TypographyP>` div; this component
// replaces that with a single `<PageHeader title="…" breadcrumb={…}>`
// call so the breadcrumb wiring is one place instead of five.
//
// Lives under `app/` (not `components/`) because the breadcrumb
// is a layout concern - the next page to ship in (app) just imports
// this once and the breadcrumb is automatic.
import type { ReactNode } from 'react';

import { Breadcrumb, Heading } from '@paalstack/react-ui';

export type PageHeaderProps = {
  /** Page title (e.g. "Lead Inbox", "Site Visits"). */
  title: string;
  /**
   * Breadcrumb crumbs, ordered root → leaf. The (app) layout is the
   * implicit root so callers usually pass `[{ label: 'Work' }, { label: title }]`
   * for top-level pages, or `[{ label: 'Work' }, { label: 'Leads', href: '/leads' }, { label: title }]`
   * for sub-pages. The last entry is rendered as the current page (no
   * link), matching the shadcn `BreadcrumbPage` convention.
   */
  breadcrumb?: ReadonlyArray<{ label: string; href?: string }>;
  /**
   * Optional right-aligned action (e.g. "+ Add lead" button, "Schedule
   * visit" trigger). The header reserves space for it even when null
   * so the page title doesn't shift on hydration.
   */
  action?: ReactNode;
  /**
   * Optional subtitle rendered under the title. The original pages
   * used a `<TypographyP>` for this; preserving it here keeps T10 a
   * pure refactor.
   */
  subtitle?: ReactNode;
};

export function PageHeader({
  title,
  breadcrumb,
  action,
  subtitle,
}: PageHeaderProps) {
  const crumbs = breadcrumb ?? [{ label: 'Work' }, { label: title }];
  return (
    <div className="border-border border-b px-4 py-3 sm:px-6 sm:py-4">
      <Breadcrumb
        items={crumbs.map((crumb) => ({
          label: crumb.label,
          ...(crumb.href !== undefined ? { href: crumb.href } : {}),
        }))}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Heading as="h1" className="truncate">
            {title}
          </Heading>
          {subtitle !== undefined && subtitle !== null ? (
            <p className="text-muted-foreground mt-0.5 text-sm">{subtitle}</p>
          ) : null}
        </div>
        {action !== undefined && action !== null ? (
          <div className="shrink-0">{action}</div>
        ) : null}
      </div>
    </div>
  );
}
