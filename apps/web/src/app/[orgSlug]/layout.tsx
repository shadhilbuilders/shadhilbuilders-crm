import { OrganizationProvider, type OrgContextValue } from '@/lib/tenant-context';
import { getOrganizationBySlug } from '@/lib/server/tenant';
import { requireTenant } from '@/lib/server/tenant-guard';
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
 *
 * FAILURE HANDLING (2026-11-19): this layout used to call `notFound()` for
 * EVERY unresolved lookup, which turned an expired session into "Page not
 * found" on every org-scoped page (reported on `/[orgSlug]/settings`).
 * `requireTenant` now routes each failure to where the user can act on it -
 * an expired session goes to sign-in, the rotation gate to /change-password,
 * an outage to the error boundary - and only a genuinely absent (or
 * invisible) tenant 404s.
 */
export default async function OrgLayout({ children, params }: LayoutProps<'/[orgSlug]'>) {
  const { orgSlug } = await params;

  const organization = requireTenant(
    await getOrganizationBySlug(orgSlug),
    `/${orgSlug}`,
    'your workspace',
  );

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
