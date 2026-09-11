import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import {
  OrganizationProvider,
  type OrgContextValue,
} from '@/lib/tenant-context';
import { getOrganizationBySlug } from '@/lib/server/tenant';
import { AuthenticatedShell } from '@/components/authenticated-shell';

export const dynamic = 'force-dynamic';

/**
 * Server OrgLayout - resolves the `[orgSlug]` URL segment to the real org
 * and hands it (id + slug) down via OrganizationProvider. This is the ONLY
 * place that knows the URL slug maps to a tenant: pages/components consume
 * `useOrgId()` (id for API hooks) / `useOrgSlug()` (slug for hrefs) so their
 * internals stay id-keyed and only the URL surface is slug-based.
 *
 * The existing client shell (SidebarProvider + AppShell + AppHeader) is
 * rendered as <AuthenticatedShell> below, unchanged - only the wrapping
 * tenant resolution is server-side (per the confirmed 2026-09-11 design).
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const organization = await getOrganizationBySlug(orgSlug);

  if (organization === null) notFound();

  const org: OrgContextValue = {
    id: organization.id,
    slug: organization.slug,
    name: organization.name,
  };

  return (
    <OrganizationProvider organization={org}>
      <AuthenticatedShell>{children}</AuthenticatedShell>
    </OrganizationProvider>
  );
}
